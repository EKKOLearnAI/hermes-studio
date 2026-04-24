export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.4.5',
    date: '2026-04-24',
    changes: ['changelog.new_0_4_5_1', 'changelog.new_0_4_5_2', 'changelog.new_0_4_5_3', 'changelog.new_0_4_5_4', 'changelog.new_0_4_5_5', 'changelog.new_0_4_5_6', 'changelog.new_0_4_5_7', 'changelog.new_0_4_5_8'],
  },
  {
    version: '0.4.4',
    date: '2026-04-23',
    changes: ['changelog.new_0_4_4_1', 'changelog.new_0_4_4_2', 'changelog.new_0_4_4_3', 'changelog.new_0_4_4_4', 'changelog.new_0_4_4_5'],
  },
  {
    version: '0.4.3',
    date: '2026-04-22',
    changes: ['changelog.new_0_4_3_1', 'changelog.new_0_4_3_2', 'changelog.new_0_4_3_3', 'changelog.new_0_4_3_4'],
  },
  {
    version: '0.4.2',
    date: '2026-04-22',
    changes: ['changelog.new_0_4_2_1', 'changelog.new_0_4_2_2', 'changelog.new_0_4_2_3', 'changelog.new_0_4_2_4', 'changelog.new_0_4_2_5'],
  },
  {
    version: '0.4.1',
    date: '2026-04-21',
    changes: ['changelog.new_0_4_1_1'],
  },
]
