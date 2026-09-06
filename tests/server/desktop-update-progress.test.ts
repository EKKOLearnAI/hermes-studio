import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('forwards real updater progress without granting remote renderer privileges',()=>{
 const main=readFileSync('packages/desktop/src/main/updater.ts','utf8')
 const window=readFileSync('packages/desktop/src/main/update-progress.ts','utf8')
 expect(main).toContain('updateProgressWindow(info)')
 expect(main).toContain('window.setProgressBar(info.percent / 100)')
 expect(window).toContain('nodeIntegration: false, contextIsolation: true, sandbox: true')
 expect(window).toContain("action: 'deny'")
 expect(window).toContain('JSON.stringify(data)')
 expect(window).toContain('state.transferred / 1048576')
})

import { vi } from 'vitest'
const fixtures=vi.hoisted(()=>({windows:[] as any[]}))
vi.mock('electron',()=>({BrowserWindow:class {
 webContents={setWindowOpenHandler:vi.fn(),on:vi.fn(),once:vi.fn(),isLoading:()=>false,executeJavaScript:vi.fn(async()=>{})}
 constructor(){fixtures.windows.push(this)}
 setMenu(){} on(){} isDestroyed(){return false} loadURL(){return Promise.resolve()} close(){} setProgressBar(){} showInactive(){}
 static getAllWindows(){return fixtures.windows}
}}))
vi.mock('../../packages/desktop/src/main/desktop-i18n',()=>({t:(key:string)=>key}))
import { updateProgressWindow, clearUpdateProgress } from '../../packages/desktop/src/main/update-progress'
import { normalizeDownloadProgress } from '../../packages/desktop/src/main/update-progress-view'
it('does not open download UI for a check failure and displays the correct download error',()=>{
 clearUpdateProgress();fixtures.windows.length=0
 updateProgressWindow(undefined,true);expect(fixtures.windows).toHaveLength(0)
 updateProgressWindow();expect(fixtures.windows).toHaveLength(1)
 updateProgressWindow({percent:46.8,transferred:117*1048576,total:250*1048576,bytesPerSecond:8.2*1048576},true)
 const script=fixtures.windows[0].webContents.executeJavaScript.mock.calls.at(-1)[0]
 expect(script).toContain('update.downloadFailed')
 expect(script).not.toContain('Could not check')
 clearUpdateProgress()
})
it('normalizes invalid progress values',()=>{
 expect(normalizeDownloadProgress({percent:Infinity,transferred:-1,total:NaN,bytesPerSecond:-20})).toEqual({percent:0,transferred:0,total:0,speed:0})
})
