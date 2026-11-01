// 暗室表示の設定は端末ごとに覚える。最初の描画より前に適用して、白い画面が一瞬出ないようにする。
export const THEME_STORAGE_KEY = "halunasu-eye-dark";

export const THEME_BOOT_SCRIPT = `try{if(window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="1"){document.documentElement.dataset.theme="dark"}}catch(e){}`;
