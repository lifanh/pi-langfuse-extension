import { applyCapturePolicy } from "./capture-policy.js";

export function buildRunPayload(event = {}, ctx = {}, config) {
  const model = event.model ?? ctx.model?.id;
  const provider = event.provider ?? ctx.model?.provider;
  const sessionId = event.sessionId ?? ctx.sessionId ?? ctx.session?.id;
  const policy = config?.capturePolicy;
  return {
    sessionId,
    ...applyCapturePolicy(
      {
        input: {
          prompt: event.prompt,
          images: event.images,
          context: event.context ?? event.attachments,
        },
        metadata: {
          agent: "pi",
          extension: "@lifanh/pi-langfuse-extension",
          model,
          provider,
          sessionId,
          cwd: event.systemPromptOptions?.cwd ?? process.cwd(),
        },
        systemPrompt: ctx.systemPrompt,
      },
      policy,
    ),
  };
}

export function buildToolPayload(event = {}, config) {
  return applyCapturePolicy(
    {
      toolInput: event.input ?? event.args ?? event.arguments ?? event.params,
      toolOutput: event.output ?? event.result ?? event.content ?? event.error,
      metadata: {
        toolName: event.toolName ?? event.name ?? "tool",
        toolCallId: event.toolCallId ?? event.id,
        isError: Boolean(event.isError || event.error),
      },
    },
    config?.capturePolicy,
  );
}
