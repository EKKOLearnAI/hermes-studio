import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/slash-commands'

export const slashCommandRoutes = new Router()

slashCommandRoutes.get('/api/hermes/slash-commands', ctrl.list)
