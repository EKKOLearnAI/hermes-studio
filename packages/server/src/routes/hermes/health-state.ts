import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/health-state'

export const healthStateRoutes = new Router()

healthStateRoutes.get('/api/hermes/health/overview', ctrl.overview)
healthStateRoutes.get('/api/hermes/health/profile', ctrl.getProfile)
healthStateRoutes.put('/api/hermes/health/profile', ctrl.updateProfile)
healthStateRoutes.get('/api/hermes/health/body-map', ctrl.getBodyMap)
healthStateRoutes.put('/api/hermes/health/body-map', ctrl.updateBodyMap)
healthStateRoutes.get('/api/hermes/health/records', ctrl.listRecords)
healthStateRoutes.post('/api/hermes/health/records', ctrl.createRecord)
healthStateRoutes.get('/api/hermes/health/scale-readings', ctrl.listScaleReadings)
healthStateRoutes.post('/api/hermes/health/scale-readings', ctrl.createScaleReading)
healthStateRoutes.get('/api/hermes/health/scale-sync', ctrl.getScaleSync)
healthStateRoutes.put('/api/hermes/health/scale-sync', ctrl.updateScaleSync)
healthStateRoutes.post('/api/hermes/health/scale-sync/run', ctrl.runScaleSyncNow)
healthStateRoutes.get('/api/hermes/health/workouts', ctrl.listWorkouts)
healthStateRoutes.post('/api/hermes/health/workouts', ctrl.createWorkout)
healthStateRoutes.get('/api/hermes/health/food/items', ctrl.listFoodItems)
healthStateRoutes.get('/api/hermes/health/food/logs', ctrl.listFoodLogs)
healthStateRoutes.post('/api/hermes/health/food/logs', ctrl.createFoodLog)
healthStateRoutes.get('/api/hermes/health/today-plan', ctrl.getTodayPlan)
healthStateRoutes.post('/api/hermes/health/check-ins', ctrl.createCheckIn)
