import path from 'node:path';
import { appConfig } from './config.js';
import { debugLog } from './debug-log.js';
import { writeSdkResource } from './sdk-resource.js';

export interface InboundAttachmentMessage {
  messageId: string;
  imagePath?: string;
  imagePaths?: string[];
}

export interface InboundResourceDescriptor {
  type?: string;
  fileKey?: string;
  fileName?: string;
}

export interface InboundDownloadTransport {
  downloadResource(messageId: string, fileKey: string, resourceType: 'image' | 'file'): Promise<unknown>;
}

export interface WriteInboundResourceOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface InboundAttachmentDownloadOptions {
  inboxDir?: string;
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  writeResource?: (
    data: unknown,
    filePath: string,
    options: WriteInboundResourceOptions,
  ) => Promise<void>;
}

interface ResourceDownloadRequest {
  messageId: string;
  fileKey: string;
  resourceType: 'image' | 'file';
  fileName: string;
  logPrefix: string;
  legacyImageLog?: boolean;
}

interface LegacyImageSelection {
  imageKeys: string[];
  parseFailed: boolean;
}

function optionNow(options: InboundAttachmentDownloadOptions): number {
  return options.now?.() ?? Date.now();
}

function optionInboxDir(options: InboundAttachmentDownloadOptions): string {
  return options.inboxDir ?? appConfig.inboxDir;
}

function safeResourceName(fileName: string, fallback: string): string {
  return fileName.replace(/[\\/:\0]/g, '_').slice(0, 120) || fallback;
}

function setDownloadedImagePaths(message: InboundAttachmentMessage, downloadedPaths: string[]): void {
  if (downloadedPaths.length === 1) {
    message.imagePath = downloadedPaths[0];
    message.imagePaths = undefined;
  } else if (downloadedPaths.length > 1) {
    message.imagePath = undefined;
    message.imagePaths = downloadedPaths;
  }
}

function selectLegacyImages(rawContent: string, messageType: string): LegacyImageSelection {
  try {
    const parsed = JSON.parse(rawContent);
    if (messageType === 'image') {
      return { imageKeys: parsed.image_key ? [parsed.image_key] : [], parseFailed: false };
    }
    if (messageType !== 'post') return { imageKeys: [], parseFailed: false };

    const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
    const imageKeys: string[] = [];
    for (const line of content) {
      for (const node of line as any[]) {
        if (node.tag === 'img' && node.image_key) {
          imageKeys.push(node.image_key);
        }
      }
    }
    return { imageKeys, parseFailed: false };
  } catch {
    return { imageKeys: [], parseFailed: messageType === 'image' || messageType === 'post' };
  }
}

export function selectLegacyImageKeys(rawContent: string, messageType: string): string[] {
  return selectLegacyImages(rawContent, messageType).imageKeys;
}

export async function downloadInboundResource(
  transport: InboundDownloadTransport,
  request: ResourceDownloadRequest,
  options: InboundAttachmentDownloadOptions = {},
): Promise<string | undefined> {
  const log = options.log ?? debugLog;
  try {
    const data = await transport.downloadResource(
      request.messageId,
      request.fileKey,
      request.resourceType,
    );
    if (!data) return undefined;

    const filePath = path.join(optionInboxDir(options), request.fileName);
    await (options.writeResource ?? writeSdkResource)(data, filePath, {
      maxBytes: options.maxBytes ?? appConfig.downloadMaxBytes,
      timeoutMs: options.timeoutMs ?? appConfig.downloadTimeoutMs,
    });
    if (request.legacyImageLog) {
      log(`[channel] Downloaded image ${request.fileKey} → ${filePath}`);
    } else {
      log(`${request.logPrefix} Downloaded ${request.resourceType} ${request.fileKey} -> ${filePath}`);
    }
    return filePath;
  } catch (err) {
    log(`${request.logPrefix} Failed to download ${request.resourceType} ${request.fileKey}: ${err}`);
    return undefined;
  }
}

export async function addSdkImageDownloads(
  message: InboundAttachmentMessage,
  resources: InboundResourceDescriptor[],
  transport: InboundDownloadTransport | undefined,
  options: InboundAttachmentDownloadOptions = {},
): Promise<void> {
  if (!transport?.downloadResource) return;
  const imageResources = resources.filter((resource) => resource.type === 'image' && resource.fileKey);
  if (imageResources.length === 0) return;

  const downloadedPaths: string[] = [];
  for (const resource of imageResources) {
    const fileKey = resource.fileKey!;
    const safeName = safeResourceName(resource.fileName ?? 'image.png', fileKey);
    const downloaded = await downloadInboundResource(transport, {
      messageId: message.messageId,
      fileKey,
      resourceType: 'image',
      fileName: `${optionNow(options)}-${fileKey}-${safeName}`,
      logPrefix: '[sdk-channel]',
    }, options);
    if (downloaded) downloadedPaths.push(downloaded);
  }

  setDownloadedImagePaths(message, downloadedPaths);
}

export async function addLegacyImageDownloads(
  message: InboundAttachmentMessage,
  rawContent: string,
  messageType: string,
  transport: InboundDownloadTransport,
  options: InboundAttachmentDownloadOptions = {},
): Promise<void> {
  const log = options.log ?? debugLog;
  const { imageKeys, parseFailed } = selectLegacyImages(rawContent, messageType);
  if (parseFailed && messageType === 'image') {
    log('[channel] Failed to parse image content for auto-download');
  } else if (parseFailed && messageType === 'post') {
    log('[channel] Failed to parse post content for image auto-download');
  }
  if (imageKeys.length === 0) return;

  const downloadedPaths: string[] = [];
  for (const imageKey of imageKeys) {
    const downloaded = await downloadInboundResource(transport, {
      messageId: message.messageId,
      fileKey: imageKey,
      resourceType: 'image',
      fileName: `${optionNow(options)}-${imageKey}.png`,
      logPrefix: '[channel]',
      legacyImageLog: true,
    }, options);
    if (downloaded) downloadedPaths.push(downloaded);
  }

  setDownloadedImagePaths(message, downloadedPaths);
}
