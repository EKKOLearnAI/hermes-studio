import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/autopilot-reminders'

export const autopilotReminderRoutes = new Router()

autopilotReminderRoutes.get('/api/hermes/autopilot-reminders/settings', ctrl.settings)
autopilotReminderRoutes.put('/api/hermes/autopilot-reminders/settings', ctrl.updateSettings)
autopilotReminderRoutes.get('/api/hermes/autopilot-reminders/deliveries', ctrl.deliveries)
autopilotReminderRoutes.post('/api/hermes/autopilot-reminders/test', ctrl.testReminder)
