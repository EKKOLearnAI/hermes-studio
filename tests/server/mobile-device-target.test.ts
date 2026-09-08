import { expect, it } from 'vitest'
import { mobileDeviceRoom, mobileDeviceId, sameMobileDevice, mobileEventAllowed } from '../../packages/server/src/modules/studio/services/chat-run/mobile-device-target'
it('isolates room and replay by authenticated user, device and Profile',()=>{
 const a={userId:'1',deviceCode:'iphone',profile:'default'}
 for(const b of [{...a,userId:'2'},{...a,deviceCode:'android'},{...a,profile:'work'}]) {
  expect(mobileDeviceRoom(a)).not.toBe(mobileDeviceRoom(b))
  expect(sameMobileDevice(a,b)).toBe(false)
  expect(mobileEventAllowed({target_device_id:a.deviceCode,target_user_id:a.userId,target_profile:a.profile},b)).toBe(false)
 }
 expect(mobileEventAllowed({},a)).toBe(false)
 expect(mobileDeviceId(a)).not.toContain('iphone')
 expect(sameMobileDevice(a,{...a})).toBe(true)
})
