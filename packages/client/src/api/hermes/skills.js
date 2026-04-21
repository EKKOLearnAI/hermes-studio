import { request } from '../client';
export async function fetchSkills() {
    const res = await request('/api/hermes/skills');
    return res.categories;
}
export async function fetchSkillContent(skillPath) {
    const res = await request(`/api/hermes/skills/${skillPath}`);
    return res.content;
}
export async function fetchSkillFiles(category, skill) {
    const res = await request(`/api/hermes/skills/${category}/${skill}/files`);
    return res.files;
}
export async function fetchMemory() {
    return request('/api/hermes/memory');
}
export async function saveMemory(section, content) {
    await request('/api/hermes/memory', {
        method: 'POST',
        body: JSON.stringify({ section, content }),
    });
}
export async function toggleSkill(name, enabled) {
    await request('/api/hermes/skills/toggle', {
        method: 'PUT',
        body: JSON.stringify({ name, enabled }),
    });
}
