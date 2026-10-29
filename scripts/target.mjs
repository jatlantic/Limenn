// Which browser a build is for: LIMENN_TARGET=firefox (see `npm run build:firefox`), Chrome otherwise.
// The sources are shared; the targets differ in the manifest and the output folder.
export const TARGET = process.env.LIMENN_TARGET === 'firefox' ? 'firefox' : 'chrome';
// LIMENN_LITE=1 leaves the second detector out (~350 MB), which brings the Firefox package under Mozilla's 200 MB signing limit.
export const LITE = process.env.LIMENN_LITE === '1';
export const DIST = `${TARGET === 'firefox' ? 'dist-firefox' : 'dist'}${LITE ? '-lite' : ''}`;
/** Model files this build ships (see models/models.lock.json). */
export const shipped = (files) => files.filter((f) => !(LITE && f.second_detector));

/** The Chrome manifest (public/manifest.json) turned into one Firefox accepts: event page, sidebar, no side panel/offscreen. */
export function firefoxManifest(m) {
  const { minimum_chrome_version, side_panel, options_page, background, ...rest } = m;
  return {
    ...rest,
    background: { scripts: ['background.js'] },
    sidebar_action: {
      default_title: 'limenn',
      default_panel: side_panel.default_path,
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' },
    },
    options_ui: { page: options_page, open_in_tab: true },
    permissions: m.permissions.filter((p) => p !== 'sidePanel' && p !== 'offscreen'),
    // The engine runs in a hidden iframe of the background page, so pages may frame themselves.
    content_security_policy: { extension_pages: m.content_security_policy.extension_pages.replace("frame-ancestors 'none'", "frame-ancestors 'self'") },
    browser_specific_settings: {
      gecko: {
        id: 'limenn@limenn.io',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}
