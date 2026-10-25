// Welcome page, opened once after installation: the three steps to get going.
import { logoSvg } from '../shared/logo';

document.getElementById('logo')!.innerHTML = logoSvg(20, 'wl-logo');
document.getElementById('open-workspace')!.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:workspace:open' }));
document.querySelectorAll<HTMLButtonElement>('[data-site]').forEach((b) =>
  b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:workspace:open-site', site: b.dataset.site })),
);
