<script setup lang="ts">
import { NEmpty, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ActionCapabilityDto, ActionExecutorDto } from '@/api/hermes/action-fabric'
import type { AssistantRoleSummary } from '@/api/hermes/assistant-roles'
import { useActionFabricMessages } from './action-fabric-messages'

defineProps<{ capabilities: ActionCapabilityDto[]; executors: ActionExecutorDto[]; roles: AssistantRoleSummary[] }>()
const { locale } = useI18n()
const { messages: m } = useActionFabricMessages(locale)

function declaration(role: AssistantRoleSummary, capabilityId: string): 'allow' | 'deny' | 'none' {
  if (role.capabilityScope.deny.includes(capabilityId)) return 'deny'
  if (role.capabilityScope.allow.includes(capabilityId)) return 'allow'
  return 'none'
}
</script>

<template>
  <section class="registry" aria-labelledby="capability-registry-title">
    <h3 id="capability-registry-title">{{ m.capabilities }}</h3>
    <NEmpty v-if="!capabilities.length" :description="m.noCapabilities" />
    <ul v-else class="card-list" aria-label="Capability registry">
      <li v-for="capability in capabilities.slice(0, 200)" :key="capability.id" class="registry-card">
        <div class="heading"><strong>{{ capability.id }}</strong><NTag size="small">{{ capability.enabled ? m.enabled : m.disabled }}</NTag></div>
        <p>{{ capability.description }}</p>
        <dl>
          <dt>{{ m.risk }}</dt><dd>{{ capability.risk }}</dd>
          <dt>{{ m.idempotency }}</dt><dd>{{ capability.idempotency }}</dd>
          <dt>{{ m.reversibleLabel }}</dt><dd>{{ capability.reversible ? m.yes : m.no }}</dd>
          <dt>{{ m.verification }}</dt><dd>{{ capability.verificationStrategy }}</dd>
        </dl>
        <div class="declarations">
          <strong>{{ m.roleAuthorization }}</strong>
          <NEmpty v-if="!roles.length" :description="m.noRoles" />
          <ul v-else>
            <li v-for="role in roles.slice(0, 100)" :key="`${capability.id}-${role.id}`">
              <span>{{ role.name }}</span>
              <NTag size="small" :type="declaration(role, capability.id) === 'deny' ? 'error' : declaration(role, capability.id) === 'allow' ? 'success' : 'default'">
                {{ declaration(role, capability.id) === 'deny' ? m.denyDeclaration : declaration(role, capability.id) === 'allow' ? m.allowDeclaration : m.notDeclared }}
              </NTag>
            </li>
          </ul>
        </div>
      </li>
    </ul>
    <h4>{{ m.executors }}</h4>
    <NEmpty v-if="!executors.length" :description="m.noExecutors" />
    <ul v-else class="executor-list" aria-label="Executor registry">
      <li v-for="executor in executors.slice(0, 100)" :key="executor.id" class="registry-card">
        <strong>{{ executor.name }}</strong><span>{{ executor.type }}</span><span>{{ m.environment }}: {{ executor.environment }}</span>
        <span>{{ m.health }}: <NTag size="small" :type="executor.health === 'healthy' ? 'success' : executor.health === 'degraded' ? 'warning' : 'error'">{{ executor.health }}</NTag></span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.registry { display:flex; flex-direction:column; gap:12px; } h3,h4,p { margin:0; } .card-list,.executor-list,.declarations ul { list-style:none; padding:0; margin:0; } .card-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; } .registry-card { padding:14px; border:1px solid var(--border-color); border-radius:10px; background:var(--card-color); overflow-wrap:anywhere; } .heading,.declarations li { display:flex; justify-content:space-between; align-items:center; gap:8px; } dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 10px; } dt { font-weight:600; } dd { margin:0; } .declarations { display:flex; flex-direction:column; gap:8px; } .declarations ul { display:flex; flex-direction:column; gap:6px; } .executor-list { display:grid; gap:8px; } .executor-list li { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
</style>
