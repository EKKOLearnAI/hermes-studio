import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('forwards real updater progress without granting remote renderer privileges',()=>{
 const main=readFileSync('packages/desktop/src/main/updater.ts','utf8')
 const window=readFileSync('packages/desktop/src/main/update-progress.ts','utf8')
 expect(main).toContain('updateProgressWindow(info)')
 expect(main).toContain('window.setProgressBar(info.percent / 100)')
 expect(window).toContain('nodeIntegration: false, contextIsolation: true, sandbox: true')
 expect(window).toContain("action: 'deny'")
 expect(window).toContain('JSON.stringify(message)')
 expect(window).toContain('state.transferred / 1048576')
})
