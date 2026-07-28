import Router from '@koa/router'
import * as ctrl from '../controllers/theme'

export const themeRoutes = new Router()

themeRoutes.get('/api/theme', ctrl.getTheme)
themeRoutes.put('/api/theme', ctrl.updateTheme)
themeRoutes.post('/api/theme/background', ctrl.uploadThemeBackground)
themeRoutes.get('/api/theme/background', ctrl.getThemeBackground)
themeRoutes.delete('/api/theme/background', ctrl.deleteThemeBackground)
