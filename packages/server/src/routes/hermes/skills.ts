import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/skills'

export const skillRoutes = new Router()

skillRoutes.get('/api/hermes/skills', ctrl.list)
skillRoutes.put('/api/hermes/skills/toggle', ctrl.toggle)
skillRoutes.get('/api/hermes/skills/:category/:skill/files', ctrl.listFiles)
skillRoutes.get('/api/hermes/skills/{*path}', ctrl.readFile_)
