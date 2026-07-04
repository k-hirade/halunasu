function extractErrorMessage(payload) {
  return payload?.error?.message || payload?.message || payload?.raw || "unknown error";
}

function buildSafeProviderMessage({ status, payload, model }) {
  const parts = [`openai_response_failed status=${status}`];
  const providerError = payload?.error || {};

  if (providerError.type) {
    parts.push(`type=${providerError.type}`);
  }

  if (providerError.code) {
    parts.push(`code=${providerError.code}`);
  }

  if (providerError.param) {
    parts.push(`param=${providerError.param}`);
  }

  if (model) {
    parts.push(`model=${model}`);
  }

  return parts.join(" ");
}

function structuredResponseTimeoutError({ model, timeoutMs }) {
  const timeoutError = new Error(`OpenAI structured response timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  timeoutError.provider = "openai";
  timeoutError.providerModel = model;
  timeoutError.safeProviderMessage = `openai_response_timeout model=${model} timeout_ms=${timeoutMs}`;
  return timeoutError;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];

  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

async function parseJsonResponse(response) {
  if (typeof response.text !== "function") {
    return typeof response.json === "function" ? response.json().catch(() => null) : null;
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function readJsonStringToken(text, quoteIndex) {
  let value = "";
  let escaped = false;

  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      if (char === "n") value += "\n";
      else if (char === "r") value += "\r";
      else if (char === "t") value += "\t";
      else value += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      return { value, end: index + 1, closed: true };
    }

    value += char;
  }

  return { value, end: text.length, closed: false };
}

function extractPartialJsonStringField(text, fieldName) {
  try {
    const parsed = JSON.parse(text);
    const value = parsed?.[fieldName];
    return typeof value === "string" ? value : "";
  } catch {
    // Continue with a tolerant partial parser while the streamed JSON is incomplete.
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\"") {
      continue;
    }

    const key = readJsonStringToken(text, index);
    index = Math.max(index, key.end - 1);

    if (!key.closed || key.value !== fieldName) {
      continue;
    }

    let cursor = key.end;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (text[cursor] !== ":") {
      continue;
    }
    cursor += 1;
    while (/\s/.test(text[cursor] || "")) cursor += 1;

    if (text[cursor] !== "\"") {
      return "";
    }

    return readJsonStringToken(text, cursor).value;
  }

  return "";
}

function extractStreamDelta(event) {
  if (typeof event?.delta === "string") {
    return event.delta;
  }

  if (typeof event?.text === "string" && event.type === "response.output_text.delta") {
    return event.text;
  }

  return "";
}

function getStreamDoneText(event) {
  if (
    ["response.output_text.done", "response.text.done"].includes(event?.type) &&
    typeof event.text === "string"
  ) {
    return event.text;
  }

  return "";
}

function parseSseEventBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") {
    return null;
  }

  return JSON.parse(data);
}

async function readStreamedStructuredResponse(response, { onOutputTextDelta, onOutputTextSnapshot } = {}) {
  if (!response.body) {
    throw new Error("OpenAI structured response stream was empty");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader?.();
  let buffer = "";
  let outputText = "";
  let completedPayload = null;
  let lastSnapshot = "";

  const emitSnapshot = async () => {
    if (typeof onOutputTextSnapshot !== "function") {
      return;
    }

    const snapshot = extractPartialJsonStringField(outputText, "output_text");
    if (snapshot && snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      await onOutputTextSnapshot(snapshot, {
        rawOutputTextLength: outputText.length
      });
    }
  };

  const processEvent = async (event) => {
    if (!event) {
      return;
    }

    if (event.type === "error" || event.error) {
      const detail = event.error?.message || event.message || "stream error";
      throw new Error(`OpenAI structured response stream failed: ${detail}`);
    }

    const doneText = getStreamDoneText(event);
    if (doneText) {
      outputText = doneText;
      await emitSnapshot();
      return;
    }

    const delta = extractStreamDelta(event);
    if (delta) {
      outputText += delta;
      await onOutputTextDelta?.(delta, outputText);
      await emitSnapshot();
      return;
    }

    if (event.type === "response.completed" && event.response) {
      completedPayload = event.response;
    }
  };

  const processBuffer = async (flush = false) => {
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      await processEvent(parseSseEventBlock(block));
      separatorIndex = buffer.indexOf("\n\n");
    }

    if (flush && buffer.trim()) {
      await processEvent(parseSseEventBlock(buffer));
      buffer = "";
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      await processBuffer();
    }
  } else {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      await processBuffer();
    }
  }

  buffer += decoder.decode();
  await processBuffer(true);

  if (!outputText && completedPayload) {
    outputText = extractOutputText(completedPayload);
    await emitSnapshot();
  }

  return {
    payload: completedPayload,
    outputText
  };
}

export async function createStructuredOpenAiResponse({
  apiKey,
  model,
  instructions,
  input,
  schemaName,
  schema,
  reasoningEffort = "low",
  stream = false,
  onOutputTextDelta = null,
  onOutputTextSnapshot = null,
  timeoutMs = 0,
  maxOutputTokens = 0
}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const shouldStream = stream || typeof onOutputTextDelta === "function" || typeof onOutputTextSnapshot === "function";
  const body = {
    model,
    store: false,
    instructions,
    input,
    reasoning: {
      effort: reasoningEffort
    },
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema
      }
    }
  };

  // decode時間は出力トークンにほぼ線形(実測139tok/s)。暴走出力の上限を設ける(0=無制限)。
  if (Number(maxOutputTokens) > 0) {
    body.max_output_tokens = Math.floor(Number(maxOutputTokens));
  }

  if (shouldStream) {
    body.stream = true;
  }

  const controller = Number(timeoutMs) > 0 ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(new Error(`OpenAI structured response timed out after ${timeoutMs}ms`)), Number(timeoutMs))
    : null;
  let response;
  let payload;
  let streamed;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller?.signal
    });

    if (!response.ok) {
      const errorPayload = await parseJsonResponse(response);
      const providerError = errorPayload?.error || {};
      const error = new Error(
        `OpenAI structured response failed (${response.status}): ${extractErrorMessage(errorPayload)}`
      );
      error.provider = "openai";
      error.providerStatusCode = response.status;
      error.providerErrorType = providerError.type || null;
      error.providerErrorCode = providerError.code || null;
      error.providerErrorParam = providerError.param || null;
      error.providerModel = model;
      error.safeProviderMessage = buildSafeProviderMessage({ status: response.status, payload: errorPayload, model });
      throw error;
    }

    streamed = shouldStream
      ? await readStreamedStructuredResponse(response, { onOutputTextDelta, onOutputTextSnapshot })
      : null;
    payload = streamed?.payload || await response.json().catch((error) => {
      if (controller?.signal?.aborted) {
        throw error;
      }
      return null;
    });
  } catch (error) {
    if (error?.name === "AbortError" || controller?.signal?.aborted) {
      throw structuredResponseTimeoutError({ model, timeoutMs });
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  const text = (streamed?.outputText || extractOutputText(payload)).trim();

  if (!text) {
    throw new Error("OpenAI structured response returned no output text");
  }

  try {
    return {
      parsed: JSON.parse(text),
      responseId: payload?.id || null,
      outputText: text,
      usage: payload?.usage || null
    };
  } catch (error) {
    throw new Error(`OpenAI structured response JSON parse failed: ${error.message}`);
  }
}
