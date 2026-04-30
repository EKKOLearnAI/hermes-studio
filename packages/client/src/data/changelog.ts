export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.5.1',
    date: '2026-04-29',
    changes: [
      'changelog.new_0_5_1_1',
      'changelog.new_0_5_1_2',
      'changelog.new_0_5_1_3',
      'changelog.new_0_5_1_4',
      'changelog.new_0_5_1_5',
      'changelog.new_0_5_1_6',
      'changelog.new_0_5_1_7',
      'changelog.new_0_5_1_8',
      'changelog.new_0_5_1_9',
    ],
  },
  {
    version: '0.5.0',
    date: '2025-04-29',
    changes: ['changelog.new_0_5_0_1', 'changelog.new_0_5_0_2'],
  },
  {
    version: '0.4.9',
    date: '2026-04-26',
    changes: ['changelog.new_0_4_8_1', 'changelog.new_0_4_8_2', 'changelog.new_0_4_8_3', 'changelog.new_0_4_8_4', 'changelog.new_0_4_8_5', 'changelog.new_0_4_8_7', 'changelog.new_0_4_8_8', 'changelog.new_0_4_8_9', 'changelog.new_0_4_8_10'],
  },
  {
    version: '0.4.7',
    date: '2026-04-25',
    changes: ['changelog.new_0_4_7_1', 'changelog.new_0_4_7_2', 'changelog.new_0_4_7_3', 'changelog.new_0_4_7_4', 'changelog.new_0_4_7_5', 'changelog.new_0_4_7_6', 'changelog.new_0_4_7_7', 'changelog.new_0_4_7_8', 'changelog.new_0_4_7_9', 'changelog.new_0_4_7_10', 'changelog.new_0_4_7_11'],
  },
  {
    version: '0.4.5',
    date: '2026-04-24',
    changes: ['changelog.new_0_4_5_1', 'changelog.new_0_4_5_2', 'changelog.new_0_4_5_3', 'changelog.new_0_4_5_4', 'changelog.new_0_4_5_5', 'changelog.new_0_4_5_6', 'changelog.new_0_4_5_7', 'changelog.new_0_4_5_8'],
  },
]
