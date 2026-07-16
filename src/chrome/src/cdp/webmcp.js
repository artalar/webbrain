/**
 * Chrome DevTools Protocol client for the experimental WebMCP domain.
 *
 * Discovery: WebMCP.enable → toolsAdded / toolsRemoved events.
 * Invocation: WebMCP.invokeTool → toolResponded (by invocationId).
 *
 * Fallback: when the WebMCP CDP domain is unavailable (older Chrome, flag
 * off, or attach restrictions), discover/invoke via Runtime.evaluate against
 * document.modelContext (and legacy navigator.modelContext).
 */

import { cdpClient } from './cdp-client.js';
import {
  MAX_WEBMCP_TOOLS,
  normalizeWebMcpTools,
} from '../agent/webmcp-tools.js';

const INVOKE_TIMEOUT_MS = 60000;
const FALLBACK_EVAL_TIMEOUT_MS = 20000;

function toolKey(frameId, name) {
  return `${String(frameId || '')}::${String(name || '')}`;
}

export class WebMcpClient {
  constructor(client = cdpClient) {
    this.cdp = client;
    this.sessions = new Map();
  }

  _session(tabId) {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = {
        enabled: false,
        domainAvailable: null,
        toolsByKey: new Map(),
        pending: new Map(),
        handlers: [],
        lastError: '',
        origin: '',
      };
      this.sessions.set(tabId, session);
    }
    return session;
  }

  clear(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    for (const pending of session.pending.values()) {
      try { pending.reject(new Error('WebMCP session cleared')); } catch {}
    }
    session.pending.clear();
    for (const { event, handler } of session.handlers) {
      try { this.cdp.off(tabId, event, handler); } catch {}
    }
    session.handlers = [];
    session.toolsByKey.clear();
    session.enabled = false;
    session.domainAvailable = null;
    session.lastError = '';
    this.sessions.delete(tabId);
  }

  listRawTools(tabId) {
    const session = this._session(tabId);
    return [...session.toolsByKey.values()];
  }

  listTools(tabId, opts = {}) {
    return normalizeWebMcpTools(this.listRawTools(tabId), opts);
  }

  async ensureEnabled(tabId) {
    const session = this._session(tabId);
    if (session.enabled && session.domainAvailable === true) {
      return { ok: true, transport: 'cdp', tools: this.listTools(tabId) };
    }

    await this.cdp.attach(tabId);
    await this._refreshOrigin(tabId);

    if (session.domainAvailable !== false) {
      try {
        await this._enableCdpDomain(tabId);
        session.domainAvailable = true;
        session.enabled = true;
        session.lastError = '';
        return { ok: true, transport: 'cdp', tools: this.listTools(tabId) };
      } catch (error) {
        const message = error?.message || String(error);
        session.domainAvailable = /unknown|not found|doesn't exist|does not exist|unsupported|Invalid/i.test(message)
          ? false
          : null;
        session.lastError = message;
        if (session.domainAvailable !== false) {
          return { ok: false, transport: 'cdp', error: message, tools: [] };
        }
      }
    }

    try {
      const tools = await this._fallbackListTools(tabId);
      session.toolsByKey.clear();
      for (const tool of tools) {
        session.toolsByKey.set(toolKey(tool.frameId, tool.name), tool);
      }
      session.enabled = true;
      session.lastError = '';
      return { ok: true, transport: 'evaluate', tools: this.listTools(tabId) };
    } catch (error) {
      session.lastError = error?.message || String(error);
      return { ok: false, transport: 'evaluate', error: session.lastError, tools: [] };
    }
  }

  async refresh(tabId) {
    const session = this._session(tabId);
    session.enabled = false;
    if (session.domainAvailable === true) {
      try {
        await this.cdp.sendCommand(tabId, 'WebMCP.disable');
      } catch {}
      session.domainAvailable = null;
    }
    session.toolsByKey.clear();
    return this.ensureEnabled(tabId);
  }

  async invoke(tabId, toolName, input = {}, opts = {}) {
    const ready = await this.ensureEnabled(tabId);
    if (!ready.ok && !this.listRawTools(tabId).length) {
      return {
        success: false,
        error: ready.error || 'WebMCP is not available on this page. Enable chrome://flags/#enable-webmcp-testing or use a Chrome build with the WebMCP origin trial.',
      };
    }

    const pageName = String(opts.pageName || toolName || '').trim();
    const frameId = String(opts.frameId || '').trim();
    const raw = this._findRawTool(tabId, pageName, frameId);
    if (!raw && ready.transport === 'cdp') {
      return {
        success: false,
        error: `WebMCP tool "${pageName}" is not registered on this page. Call list_webmcp_tools and retry with a current name.`,
      };
    }

    if (ready.transport === 'cdp' || this._session(tabId).domainAvailable === true) {
      return this._invokeViaCdp(tabId, raw || { name: pageName, frameId }, input);
    }
    return this._invokeViaEvaluate(tabId, pageName, input);
  }

  _findRawTool(tabId, pageName, frameId) {
    const session = this._session(tabId);
    if (frameId) {
      const exact = session.toolsByKey.get(toolKey(frameId, pageName));
      if (exact) return exact;
    }
    for (const tool of session.toolsByKey.values()) {
      if (tool.name === pageName) return tool;
    }
    return null;
  }

  async _enableCdpDomain(tabId) {
    const session = this._session(tabId);
    for (const { event, handler } of session.handlers) {
      try { this.cdp.off(tabId, event, handler); } catch {}
    }
    session.handlers = [];
    session.toolsByKey.clear();

    const register = (event, handler) => {
      this.cdp.on(tabId, event, handler);
      session.handlers.push({ event, handler });
    };

    register('WebMCP.toolsAdded', (params = {}) => {
      for (const tool of params.tools || []) {
        if (!tool?.name) continue;
        session.toolsByKey.set(toolKey(tool.frameId, tool.name), {
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema,
          annotations: tool.annotations || {},
          frameId: tool.frameId || '',
          backendNodeId: tool.backendNodeId ?? null,
          origin: session.origin,
        });
        while (session.toolsByKey.size > MAX_WEBMCP_TOOLS) {
          const first = session.toolsByKey.keys().next().value;
          session.toolsByKey.delete(first);
        }
      }
    });

    register('WebMCP.toolsRemoved', (params = {}) => {
      for (const tool of params.tools || []) {
        if (!tool?.name) continue;
        session.toolsByKey.delete(toolKey(tool.frameId, tool.name));
      }
    });

    register('WebMCP.toolResponded', (params = {}) => {
      const pending = session.pending.get(params.invocationId);
      if (!pending) return;
      session.pending.delete(params.invocationId);
      clearTimeout(pending.timer);
      pending.resolve(params);
    });

    await this.cdp.sendCommand(tabId, 'WebMCP.enable');
  }

  async _invokeViaCdp(tabId, tool, input) {
    const session = this._session(tabId);
    const frameId = tool.frameId || await this._mainFrameId(tabId);
    if (!frameId) {
      return { success: false, error: 'Could not resolve a frameId for WebMCP.invokeTool.' };
    }

    let invocationId;
    try {
      const response = await this.cdp.sendCommand(tabId, 'WebMCP.invokeTool', {
        frameId,
        toolName: tool.name,
        input: input && typeof input === 'object' ? input : {},
      });
      invocationId = response?.invocationId;
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }

    if (!invocationId) {
      return { success: false, error: 'WebMCP.invokeTool returned no invocationId.' };
    }

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(invocationId);
        reject(new Error(`WebMCP tool "${tool.name}" timed out after ${INVOKE_TIMEOUT_MS}ms`));
      }, INVOKE_TIMEOUT_MS);
      session.pending.set(invocationId, { resolve, reject, timer });
    }).catch((error) => ({ status: 'Error', errorText: error.message }));

    return this._normalizeInvocationResult(tool.name, result);
  }

  async _mainFrameId(tabId) {
    try {
      await this.cdp.sendCommand(tabId, 'Page.enable');
      const tree = await this.cdp.sendCommand(tabId, 'Page.getFrameTree');
      return tree?.frameTree?.frame?.id || '';
    } catch {
      return '';
    }
  }

  async _refreshOrigin(tabId) {
    const session = this._session(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      session.origin = tab?.url ? new URL(tab.url).origin : '';
    } catch {
      session.origin = '';
    }
  }

  async _fallbackListTools(tabId) {
    const expression = `(() => {
      const ctx = (typeof document !== 'undefined' && document.modelContext)
        || (typeof navigator !== 'undefined' && navigator.modelContext)
        || null;
      if (!ctx || typeof ctx.getTools !== 'function') {
        return { available: false, tools: [], error: 'document.modelContext is not available on this page' };
      }
      return Promise.resolve(ctx.getTools()).then((tools) => {
        const list = Array.isArray(tools) ? tools : [];
        return {
          available: true,
          tools: list.slice(0, ${MAX_WEBMCP_TOOLS}).map((tool) => ({
            name: String(tool?.name || ''),
            description: String(tool?.description || ''),
            inputSchema: tool?.inputSchema ?? tool?.parameters ?? null,
            annotations: tool?.annotations || {},
            origin: String(tool?.origin || location.origin || ''),
            frameId: '',
          })),
        };
      }).catch((error) => ({
        available: false,
        tools: [],
        error: String(error && error.message ? error.message : error),
      }));
    })()`;

    const evaluated = await this.cdp.evaluate(tabId, expression, true, {
      timeoutMs: FALLBACK_EVAL_TIMEOUT_MS,
    });
    const value = evaluated?.result?.value;
    if (!value?.available) {
      throw new Error(value?.error || evaluated?.exceptionDetails?.text || 'WebMCP page API unavailable');
    }
    return (value.tools || []).filter((tool) => tool?.name);
  }

  async _invokeViaEvaluate(tabId, toolName, input) {
    const argsJson = JSON.stringify(input && typeof input === 'object' ? input : {});
    const nameJson = JSON.stringify(String(toolName || ''));
    const expression = `(() => {
      const ctx = (typeof document !== 'undefined' && document.modelContext)
        || (typeof navigator !== 'undefined' && navigator.modelContext)
        || null;
      if (!ctx || typeof ctx.getTools !== 'function' || typeof ctx.executeTool !== 'function') {
        return Promise.resolve({
          success: false,
          error: 'document.modelContext.executeTool is not available on this page',
        });
      }
      return Promise.resolve(ctx.getTools()).then((tools) => {
        const list = Array.isArray(tools) ? tools : [];
        const tool = list.find((item) => item && item.name === ${nameJson});
        if (!tool) {
          return {
            success: false,
            error: 'WebMCP tool not found: ' + ${nameJson},
          };
        }
        return Promise.resolve(ctx.executeTool(tool, ${JSON.stringify(argsJson)})).then((output) => ({
          success: true,
          navigated: output == null,
          output: output == null ? null : output,
        })).catch((error) => ({
          success: false,
          error: String(error && error.message ? error.message : error),
        }));
      });
    })()`;

    try {
      const evaluated = await this.cdp.evaluate(tabId, expression, true, {
        timeoutMs: FALLBACK_EVAL_TIMEOUT_MS,
      });
      if (evaluated?.exceptionDetails) {
        return {
          success: false,
          error: evaluated.exceptionDetails.text || 'WebMCP executeTool threw',
        };
      }
      const value = evaluated?.result?.value;
      if (!value || value.success === false) {
        return {
          success: false,
          error: value?.error || 'WebMCP executeTool failed',
        };
      }
      return {
        success: true,
        webmcp: true,
        transport: 'evaluate',
        tool: toolName,
        navigated: !!value.navigated,
        result: value.output,
        note: value.navigated
          ? 'Tool triggered a navigation; page context may have changed.'
          : undefined,
      };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  _normalizeInvocationResult(toolName, params) {
    const status = String(params?.status || '');
    if (status === 'Completed' || (!status && params?.output !== undefined)) {
      return {
        success: true,
        webmcp: true,
        transport: 'cdp',
        tool: toolName,
        result: params.output,
      };
    }
    if (status === 'Canceled') {
      return {
        success: false,
        cancelled: true,
        webmcp: true,
        error: params.errorText || `WebMCP tool "${toolName}" was canceled`,
      };
    }
    return {
      success: false,
      webmcp: true,
      error: params.errorText
        || (params.exception && (params.exception.description || params.exception.value))
        || `WebMCP tool "${toolName}" failed`,
    };
  }

  async cancelAll(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    for (const [invocationId, pending] of [...session.pending.entries()]) {
      try {
        await this.cdp.sendCommand(tabId, 'WebMCP.cancelInvocation', { invocationId });
      } catch {}
      clearTimeout(pending.timer);
      session.pending.delete(invocationId);
      try { pending.reject(new Error('WebMCP invocation canceled')); } catch {}
    }
  }
}

export const webmcpClient = new WebMcpClient();
