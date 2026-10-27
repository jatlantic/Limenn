/** One code base serves Chrome and Firefox; the few differences are decided at run time. */
export const IS_FIREFOX = navigator.userAgent.includes('Firefox/');

/** The folder picker behind the Document vault exists in Chromium browsers only. */
export const HAS_FOLDER_PICKER = 'showDirectoryPicker' in globalThis;
