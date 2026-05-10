import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/kanban'

export const kanbanRoutes = new Router()

kanbanRoutes.get('/api/hermes/kanban/boards', ctrl.listBoards)
kanbanRoutes.post('/api/hermes/kanban/boards', ctrl.createBoard)
kanbanRoutes.delete('/api/hermes/kanban/boards/:slug', ctrl.archiveBoard)
kanbanRoutes.get('/api/hermes/kanban/capabilities', ctrl.capabilities)
kanbanRoutes.get('/api/hermes/kanban/stats', ctrl.stats)
kanbanRoutes.get('/api/hermes/kanban/assignees', ctrl.assignees)
kanbanRoutes.get('/api/hermes/kanban/artifact', ctrl.readArtifact)
kanbanRoutes.get('/api/hermes/kanban/search-sessions', ctrl.searchSessions)
kanbanRoutes.get('/api/hermes/kanban', ctrl.list)
kanbanRoutes.get('/api/hermes/kanban/:id', ctrl.get)
kanbanRoutes.post('/api/hermes/kanban', ctrl.create)
kanbanRoutes.post('/api/hermes/kanban/complete', ctrl.complete)
kanbanRoutes.post('/api/hermes/kanban/unblock', ctrl.unblock)
kanbanRoutes.post('/api/hermes/kanban/:id/block', ctrl.block)
kanbanRoutes.post('/api/hermes/kanban/:id/assign', ctrl.assign)
