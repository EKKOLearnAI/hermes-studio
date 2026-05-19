import { execFile } from 'child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hermes-bridge-profile-env-'))
})

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

async function runBridgeProbe(script: string): Promise<any> {
  const bridgePath = resolve('packages/server/src/services/hermes/agent-bridge/hermes_bridge.py')
  const { stdout } = await execFileAsync('python3', ['-c', script], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      BRIDGE_PATH: bridgePath,
      TEST_HERMES_HOME: tempDir,
    },
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout)
}

describe('agent bridge profile environment', () => {
  it('runs agent calls with the requested profile HERMES_HOME and restores the bridge home', async () => {
    const profileHome = join(tempDir, 'profiles', 'work')
    await mkdir(profileHome, { recursive: true })
    await writeFile(join(tempDir, 'config.yaml'), 'model:\n  default: default-model\n', 'utf-8')
    await writeFile(join(tempDir, '.env'), 'OPENAI_API_KEY=default-openai\nBASE_ONLY_TOKEN=base-token\n', 'utf-8')
    await writeFile(join(profileHome, 'config.yaml'), 'model:\n  default: work-model\n', 'utf-8')
    await writeFile(join(profileHome, '.env'), 'GLM_API_KEY=work-glm\n', 'utf-8')
    const expectedProfileHome = await realpath(profileHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
profile_home = os.path.join(root, "profiles", "work")
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root
os.environ["OPENAI_API_KEY"] = "shell-openai"
os.environ["GLM_API_KEY"] = "shell-glm"

class FakeAgent:
    def __init__(self):
        self.seen_home = None
        self.seen_openai = None
        self.seen_glm = None
        self.seen_base_only = None

    def run_conversation(self, message, **kwargs):
        self.seen_home = os.environ.get("HERMES_HOME")
        self.seen_openai = os.environ.get("OPENAI_API_KEY")
        self.seen_glm = os.environ.get("GLM_API_KEY")
        self.seen_base_only = os.environ.get("BASE_ONLY_TOKEN")
        return {"messages": [{"role": "assistant", "content": "ok"}]}

agent = FakeAgent()
with bridge._profile_env("work"):
    result = agent.run_conversation("hello")

print(json.dumps({
    "seen_home": agent.seen_home,
    "seen_openai": agent.seen_openai,
    "seen_glm": agent.seen_glm,
    "seen_base_only": agent.seen_base_only,
    "restored_home": os.environ.get("HERMES_HOME"),
    "restored_openai": os.environ.get("OPENAI_API_KEY"),
    "restored_glm": os.environ.get("GLM_API_KEY"),
    "restored_base_only": os.environ.get("BASE_ONLY_TOKEN"),
    "status": "complete" if result.get("messages") else "error",
}))
`)

    expect(result).toEqual({
      seen_home: expectedProfileHome,
      seen_openai: null,
      seen_glm: 'work-glm',
      seen_base_only: null,
      restored_home: tempDir,
      restored_openai: 'shell-openai',
      restored_glm: 'shell-glm',
      restored_base_only: null,
      status: 'complete',
    })
  })

  it('normalizes a profile-scoped bridge home back to the Hermes root for profile lookup', async () => {
    const agentRoot = join(tempDir, 'hermes-agent')
    const profileHome = join(tempDir, 'profiles', 'work')
    await mkdir(agentRoot, { recursive: true })
    await mkdir(profileHome, { recursive: true })
    await writeFile(join(agentRoot, 'run_agent.py'), '', 'utf-8')
    await writeFile(join(profileHome, 'config.yaml'), 'model:\n  default: work-model\n', 'utf-8')
    const expectedRoot = await realpath(tempDir)
    const expectedProfileHome = await realpath(profileHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
agent_root = os.path.join(root, "hermes-agent")
profile_home = os.path.join(root, "profiles", "work")
bridge._set_path_env(agent_root, profile_home)

print(json.dumps({
    "home": os.environ.get("HERMES_HOME"),
    "base": os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME"),
    "profile_home": str(bridge._profile_home("work")),
}))
`)

    expect(result).toEqual({
      home: expectedProfileHome,
      base: expectedRoot,
      profile_home: expectedProfileHome,
    })
  })

  it('falls back to package imports when no Hermes Agent source root exists', async () => {
    const packageDir = join(tempDir, 'site-packages')
    const hermesHome = join(tempDir, 'home')
    await mkdir(packageDir, { recursive: true })
    await mkdir(hermesHome, { recursive: true })
    await writeFile(join(packageDir, 'run_agent.py'), 'class AIAgent: pass\n', 'utf-8')
    const expectedHermesHome = await realpath(hermesHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

package_dir = os.path.join(os.environ["TEST_HERMES_HOME"], "site-packages")
hermes_home = os.path.join(os.environ["TEST_HERMES_HOME"], "home")
sys.path.insert(0, package_dir)
bridge._candidate_agent_roots = lambda raw=None: []
os.environ.pop("HERMES_AGENT_ROOT", None)

bridge._set_path_env(None, hermes_home)
bridge._ensure_agent_imports()
from run_agent import AIAgent

print(json.dumps({
    "agent_root": os.environ.get("HERMES_AGENT_ROOT"),
    "home": os.environ.get("HERMES_HOME"),
    "base": os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME"),
    "agent_class": AIAgent.__name__,
}))
`)

    expect(result).toEqual({
      agent_root: null,
      home: expectedHermesHome,
      base: expectedHermesHome,
      agent_class: 'AIAgent',
    })
  })

  it('keeps inherited profile env keys for default profile compatibility', async () => {
    await mkdir(join(tempDir, 'profiles', 'work'), { recursive: true })
    await writeFile(join(tempDir, '.env'), 'OPENAI_API_KEY=default-openai\n', 'utf-8')
    await writeFile(join(tempDir, 'profiles', 'work', '.env'), 'GLM_API_KEY=work-glm\n', 'utf-8')
    await writeFile(join(tempDir, 'config.yaml'), 'model:\n  default: default-model\n', 'utf-8')

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root
os.environ["OPENAI_API_KEY"] = "shell-openai"
os.environ["GLM_API_KEY"] = "shell-glm"

with bridge._profile_env("default"):
    inside = {
        "openai": os.environ.get("OPENAI_API_KEY"),
        "glm": os.environ.get("GLM_API_KEY"),
    }

print(json.dumps({
    "inside": inside,
    "restored_openai": os.environ.get("OPENAI_API_KEY"),
    "restored_glm": os.environ.get("GLM_API_KEY"),
}))
`)

    expect(result).toEqual({
      inside: {
        openai: 'default-openai',
        glm: 'shell-glm',
      },
      restored_openai: 'shell-openai',
      restored_glm: 'shell-glm',
    })
  })
})
