// Display names and order of the CLIs that can use local (Ollama) models. A leaf module (no imports), so it can be
// used while other modules are still loading.
export const OLLAMA_CLIS_ORDER = ['pi', 'opencode', 'claude', 'codex', 'qwen', 'dsh'];
export const AGENT_LABEL = { pi: 'Pi', opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex', qwen: 'Qwen Code', dsh: 'DeepSeek Harness' };
export const AGENT_SHORT = { pi: 'Pi', opencode: 'OC', claude: 'Claude', codex: 'Codex', qwen: 'Qwen', dsh: 'DSH' };
