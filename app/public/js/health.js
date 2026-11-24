// Container health (CPU, memory, disk, worktrees) and prune.
import { $, api, h } from './core.js';

async function loadContainerHealth() {
  const box = $('#healthSummary');
  if (!box) return;
  try {
    const d = await api('GET', '/api/system/health');
    const gbStr = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');
    const upHrs = Math.floor(d.processUptimeSec / 3600);
    const upMin = Math.floor((d.processUptimeSec % 3600) / 60);
    box.replaceChildren(
      h('div', {}, `CPU load: ${d.loadavg.join(' / ')} (${d.cpus} cores) · UI up ${upHrs}h ${upMin}m`),
      h('div', {}, `RAM: ${gbStr(d.mem.used)} / ${gbStr(d.mem.total)} · Worktrees: ${d.worktrees.count} (${gbStr(d.worktrees.bytes)})`),
      d.disk && h('div', {}, `Disk: ${gbStr(d.disk.used)} / ${gbStr(d.disk.total)} (${d.disk.pct} used)`),
      h('div', {}, `Listening ports: ${d.ports.length ? d.ports.map((p) => ':' + p).join(', ') : 'none'}`));
  } catch (e) {
    box.textContent = e.message;
  }
}

export { loadContainerHealth };
