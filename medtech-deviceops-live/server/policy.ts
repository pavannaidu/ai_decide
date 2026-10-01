export const SOP = {
  version: 'SIM-SOP-2.0',
  title: 'Demo operating rules',
  scope: 'Synthetic lab equipment only. No clinical advice, device control, or quality approval.',
  rules: [
    'Two or more machines fail QC on the same reagent lot: send the lot to simulated quality review, not equipment repair.',
    'A confirmed equipment fault with no shared-lot QC failure: service that machine.',
    'Missing measurements or an unconfirmed report: ask a technician. Unknown QC does not mean failed QC.',
    'Wait when all machines are ready or responses are pending. Prioritize shared-lot QC, then equipment faults, then missing details.',
    'Review creates a simulated hold, not approval. Only a synthetic reviewer response resolves it.',
  ],
} as const;
