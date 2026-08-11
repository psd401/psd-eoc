import {
  AgentApiClient,
  AgentApiConfigurationError,
  readAgentApiConfig,
} from './agent-client';
import {
  PsdEocMcpProtocol,
  type JsonRpcResponse,
  type McpRequestContext,
} from './protocol';

const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface StdioWriter {
  write(value: Uint8Array): number;
  flush(): number | Promise<number>;
  end(error?: Error): number | Promise<number>;
}

function parseError(): JsonRpcResponse {
  return Object.freeze({
    jsonrpc: '2.0' as const,
    id: null,
    error: Object.freeze({ code: -32700, message: 'Parse error' }),
  });
}

function writeResponse(
  writer: Pick<StdioWriter, 'write' | 'flush'>,
  response: JsonRpcResponse,
): void {
  const bytes = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
  writer.write(bytes);
  void writer.flush();
}

/** Runs newline-delimited JSON-RPC without ever writing non-protocol data. */
export async function runStdioServer(
  protocol: PsdEocMcpProtocol,
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  output: StdioWriter = Bun.stdout.writer(),
): Promise<void> {
  const reader = input.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let buffered = '';
  let bufferedBytes = 0;
  let discardUntilNewline = false;
  let decodingFailed = false;
  let legacyProtocolVersion: string | undefined;

  const handleLine = async (line: string): Promise<void> => {
    if (line.trim() === '') return;

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      writeResponse(output, parseError());
      return;
    }

    const context: McpRequestContext =
      legacyProtocolVersion === undefined
        ? {}
        : { protocolVersion: legacyProtocolVersion };
    const response = await protocol.handle(value, context);
    if (response !== null) writeResponse(output, response);
    if (
      typeof value === 'object' &&
      value !== null &&
      Reflect.get(value, 'method') === 'initialize' &&
      response !== null &&
      'result' in response &&
      typeof response.result.protocolVersion === 'string'
    ) {
      legacyProtocolVersion = response.result.protocolVersion;
    }
  };

  const consumeDecoded = async (decoded: string): Promise<void> => {
    let remaining = decoded;
    while (remaining !== '') {
      if (discardUntilNewline) {
        const discardedLineEnd = remaining.indexOf('\n');
        if (discardedLineEnd < 0) return;
        discardUntilNewline = false;
        remaining = remaining.slice(discardedLineEnd + 1);
        continue;
      }

      const lineEnd = remaining.indexOf('\n');
      const hasCompleteLine = lineEnd >= 0;
      const fragment = hasCompleteLine
        ? remaining.slice(0, lineEnd)
        : remaining;
      const fragmentBytes = encoder.encode(fragment).byteLength;
      if (bufferedBytes + fragmentBytes > MAX_MESSAGE_BYTES) {
        writeResponse(output, parseError());
        buffered = '';
        bufferedBytes = 0;
        if (!hasCompleteLine) {
          discardUntilNewline = true;
          return;
        }
        remaining = remaining.slice(lineEnd + 1);
        continue;
      }

      buffered += fragment;
      bufferedBytes += fragmentBytes;
      if (!hasCompleteLine) return;

      const line = buffered.replace(/\r$/u, '');
      buffered = '';
      bufferedBytes = 0;
      remaining = remaining.slice(lineEnd + 1);
      await handleLine(line);
    }
  };

  while (true) {
    let next;
    try {
      next = await reader.read();
    } catch {
      writeResponse(output, parseError());
      return;
    }
    if (next.done) break;
    let decoded: string;
    try {
      decoded = decoder.decode(next.value, { stream: true });
    } catch {
      writeResponse(output, parseError());
      decodingFailed = true;
      break;
    }
    await consumeDecoded(decoded);
  }

  if (!decodingFailed) {
    try {
      await consumeDecoded(decoder.decode());
    } catch {
      writeResponse(output, parseError());
      decodingFailed = true;
    }
  }
  if (!decodingFailed && !discardUntilNewline && buffered.trim() !== '') {
    writeResponse(output, parseError());
  }
  await output.flush();
  output.end();
}

async function main(): Promise<void> {
  try {
    const client = new AgentApiClient(readAgentApiConfig());
    await runStdioServer(new PsdEocMcpProtocol(client));
  } catch (error) {
    const message =
      error instanceof AgentApiConfigurationError
        ? error.message
        : 'The PSD EOC MCP stdio server could not start.';
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
