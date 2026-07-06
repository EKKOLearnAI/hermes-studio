export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '0.6.26',
    date: '2026-07-06',
    changes: [
      'changelog.new_0_6_26_1',
      'changelog.new_0_6_26_2',
      'changelog.new_0_6_26_3',
      'changelog.new_0_6_26_4',
      'changelog.new_0_6_26_5',
      'changelog.new_0_6_26_6',
    ],
  },
  {
    version: '0.6.25',
    date: '2026-07-03',
    changes: [
      'changelog.new_0_6_25_1',
    ],
  },
  {
    version: '0.6.24',
    date: '2026-07-03',
    changes: [
      'changelog.new_0_6_24_1',
      'changelog.new_0_6_24_2',
      'changelog.new_0_6_24_3',
      'changelog.new_0_6_24_4',
      'changelog.new_0_6_24_5',
      'changelog.new_0_6_24_6',
    ],
  },
]
