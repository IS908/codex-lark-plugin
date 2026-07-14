export type ActionHandlerRegistry<
  Action extends { type: string },
  Message,
  Result,
> = {
  [Type in Action['type']]: (
    action: Extract<Action, { type: Type }>,
    message: Message,
  ) => Promise<Result>;
};

export async function dispatchRegisteredAction<
  Action extends { type: string },
  Message,
  Result,
>(
  registry: ActionHandlerRegistry<Action, Message, Result>,
  action: Action,
  message: Message,
): Promise<Result> {
  const handler = registry[action.type as Action['type']] as (
    action: Action,
    message: Message,
  ) => Promise<Result>;
  return handler(action, message);
}
