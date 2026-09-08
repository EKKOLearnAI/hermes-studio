import type { DropdownOption } from 'naive-ui'
import type { VNode } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  buildActiveSessionMenuOptions,
  buildSessionContextMenuOptions,
  renderSessionMenuIcon,
} from '@/components/hermes/chat/session-menu-options'

function describeOptions(options: DropdownOption[]) {
  return options.map((option) => {
    const item = option as DropdownOption & {
      icon?: () => VNode
      label?: string
      type?: string
    }
    const icon = item.icon?.()
    return {
      key: item.key,
      label: item.label,
      icon: icon?.props?.['data-session-menu-icon'],
      hasChildren: Array.isArray(item.children),
    }
  })
}

describe('session action menu options', () => {
  it('builds the compact current-session menu with an icon for every action', () => {
    const options = buildActiveSessionMenuOptions({
      outline: 'Conversation Outline',
      rename: 'Rename',
      open: 'Open in new window',
      copyId: 'Copy Session ID',
    })

    expect(describeOptions(options)).toEqual([
      { key: 'outline', label: 'Conversation Outline', icon: 'outline', hasChildren: false },
      { key: 'copy-id', label: 'Copy Session ID', icon: 'copy', hasChildren: false },
      { key: 'rename', label: 'Rename', icon: 'rename', hasChildren: false },
      { key: 'open-link', label: 'Open in new window', icon: 'open-new', hasChildren: false },
    ])

    for (const option of options) {
      const icon = (option as DropdownOption & { icon: () => VNode }).icon()
      expect(icon.type).toBe('svg')
      expect(icon.props).toMatchObject({
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
      })
    }
  })

  it('disables persistence-dependent header actions for an unsent local-only session', () => {
    const options = buildActiveSessionMenuOptions({
      outline: 'Conversation Outline',
      rename: 'Rename',
      open: 'Open in new window',
      copyId: 'Copy Session ID',
    }, {
      canRename: false,
      canOpen: false,
    })

    expect(options.map(option => ({ key: option.key, disabled: option.disabled ?? false }))).toEqual([
      { key: 'outline', disabled: false },
      { key: 'copy-id', disabled: false },
      { key: 'rename', disabled: true },
      { key: 'open-link', disabled: true },
    ])
  })

  it('adds distinct icons to all ten top-level session context actions while preserving submenus', () => {
    const categoryChildren: DropdownOption[] = [
      { label: 'Work', key: 'category:1' },
    ]
    const options = buildSessionContextMenuOptions({
      pinned: false,
      includeArchive: true,
      includeModel: true,
      categoryChildren,
      labels: {
        pin: 'Pin',
        unpin: 'Unpin',
        rename: 'Rename',
        archive: 'Archive',
        workspace: 'Set Workspace',
        model: 'Set Model',
        category: 'Move to category',
        export: 'Export',
        exportFull: 'Full Export (JSON)',
        exportCompressed: 'Compressed Export (TXT)',
        open: 'Open in new window',
        copyLink: 'Copy Session Link',
        copyId: 'Copy Session ID',
      },
    })

    expect(describeOptions(options)).toEqual([
      { key: 'pin', label: 'Pin', icon: 'pin', hasChildren: false },
      { key: 'rename', label: 'Rename', icon: 'rename', hasChildren: false },
      { key: 'archive', label: 'Archive', icon: 'archive', hasChildren: false },
      { key: 'workspace', label: 'Set Workspace', icon: 'workspace', hasChildren: false },
      { key: 'model', label: 'Set Model', icon: 'model', hasChildren: false },
      { key: 'category', label: 'Move to category', icon: 'category', hasChildren: true },
      { key: 'export', label: 'Export', icon: 'export', hasChildren: true },
      { key: 'open-link', label: 'Open in new window', icon: 'open-new', hasChildren: false },
      { key: 'copy-link', label: 'Copy Session Link', icon: 'link', hasChildren: false },
      { key: 'copy-id', label: 'Copy Session ID', icon: 'copy', hasChildren: false },
    ])
    expect(options.find(option => option.key === 'category')?.children).toBe(categoryChildren)
    expect(options.find(option => option.key === 'export')?.children).toEqual([
      {
        label: 'Full Export (JSON)',
        key: 'export-full',
        children: [
          { label: 'JSON', key: 'export-full-json' },
          { label: 'TXT', key: 'export-full-txt' },
        ],
      },
      {
        label: 'Compressed Export (TXT)',
        key: 'export-compressed',
        children: [
          { label: 'JSON', key: 'export-compressed-json' },
          { label: 'TXT', key: 'export-compressed-txt' },
        ],
      },
    ])
  })

  it('uses a clear, compact thumbtack glyph for Pin', () => {
    const icon = renderSessionMenuIcon('pin')
    const paths = (icon.children as VNode[]).map(child => child.props?.d)

    expect(paths).toEqual([
      'M8 4h8',
      'M9 4v6l-2 4v2h10v-2l-2-4V4',
      'M12 16v5',
    ])
  })

  it('uses a downward download-style glyph for Export rather than an upload glyph', () => {
    const icon = renderSessionMenuIcon('export')
    const paths = (icon.children as VNode[]).map(child => child.props?.d)

    expect(paths).toEqual([
      'M12 3v11',
      'm8 10 4 4 4-4',
      'M5 15v4h14v-4',
    ])
  })

  it('keeps the Set Model glyph lightweight and recognizable as AI rather than hardware', () => {
    const icon = renderSessionMenuIcon('model')
    const paths = (icon.children as VNode[]).map(child => child.props?.d)

    expect(paths).toEqual([
      'm12 3 1.4 4.1L17.5 9l-4.1 1.4L12 14.5l-1.4-4.1L6.5 9l4.1-1.4z',
      'm18.5 15 .7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z',
    ])
  })

  it('uses the unpin label and keeps optional actions out when they are unavailable', () => {
    const options = buildSessionContextMenuOptions({
      pinned: true,
      includeArchive: false,
      includeModel: false,
      categoryChildren: [],
      labels: {
        pin: 'Pin',
        unpin: 'Unpin',
        rename: 'Rename',
        archive: 'Archive',
        workspace: 'Set Workspace',
        model: 'Set Model',
        category: 'Move to category',
        export: 'Export',
        exportFull: 'Full Export (JSON)',
        exportCompressed: 'Compressed Export (TXT)',
        open: 'Open in new tab',
        copyLink: 'Copy Session Link',
        copyId: 'Copy Session ID',
      },
    })

    expect(options[0]?.label).toBe('Unpin')
    expect(options.map(option => option.key)).not.toContain('archive')
    expect(options.map(option => option.key)).not.toContain('model')
    expect(options.every(option => typeof (option as DropdownOption & { icon?: unknown }).icon === 'function')).toBe(true)
  })
})
