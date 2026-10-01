import { z } from 'zod';
import type { DecisionAnswers, DecisionRequest, FleetSnapshot, Policy } from '../shared/types';
import { buildCandidates } from './simulator';
import { HttpError } from './errors';

const probability = z.number().min(0).max(1);
const responseSchema = z.object({
  response: z.object({
    answers: z.object({
      next_action: z.object({
        type: z.literal('choice'),
        choice: z.string(),
        probabilities: z.record(z.string(), probability),
        confidence: probability,
      }),
      quality_review_needed: z.object({ type: z.literal('noul'), probability }).optional(),
      attention_priority: z
        .object({
          type: z.literal('score'),
          score: z.number().min(0).max(2),
          probabilities: z.record(z.string(), probability),
          legend: z.record(z.string(), z.string()),
          confidence: probability,
        })
        .optional(),
    }),
  }),
  metadata: z.object({ version: z.literal('1.0') }),
});

export function buildDecisionRequest(observed: FleetSnapshot, sop: Policy): DecisionRequest {
  return {
    questions: {
      next_action: {
        type: 'choice',
        instructions: 'What should the lab do next? Follow the demo rules using only current observations.',
        criteria: Object.fromEntries(buildCandidates(observed).map((candidate) => [candidate.id, candidate.label])),
      },
    },
    state: {
      observations: {
        qcFailuresByLot: Object.fromEntries(
          [...new Set(observed.devices.filter((device) => device.qc === 'failed').map((device) => device.lotId))].map(
            (lotId) => [
              lotId,
              observed.devices
                .filter((device) => device.lotId === lotId && device.qc === 'failed')
                .map((device) => device.id),
            ]
          )
        ),
        reportedEquipmentFaultIds: observed.devices
          .filter((device) => device.status === 'fault' && !device.pending)
          .map((device) => device.id),
        unconfirmedReportIds: observed.devices
          .filter((device) => device.status === 'ambiguous' && !device.pending)
          .map((device) => device.id),
        pendingResponseTargets: observed.pendingTasks.map((task) => task.target),
      },
      devices: observed.devices
        .filter((device) => device.status !== 'healthy')
        .map(({ id, lotId, qc, temperatureC, calibrationOffset, report, pending }) => ({
          id,
          lotId,
          qc,
          temperatureC,
          calibrationOffset,
          report,
          pending,
        })),
      sop,
      scope: 'Choose one operational action for this synthetic lab.',
    },
    options: { version: '1.0' },
  };
}

export function parseAnswers(raw: unknown, request: Pick<DecisionRequest, 'questions'>): DecisionAnswers {
  const result = responseSchema.safeParse(raw);
  if (!result.success)
    throw new HttpError(502, 'ai_decide returned an invalid response. No simulated action was applied.');
  const answers = result.data.response.answers;
  if (!Object.prototype.hasOwnProperty.call(request.questions.next_action.criteria, answers.next_action.choice)) {
    throw new HttpError(502, 'ai_decide selected an action outside the offered candidates. No action was applied.');
  }
  if (
    Object.keys(answers.next_action.probabilities).some(
      (key) => !Object.prototype.hasOwnProperty.call(request.questions.next_action.criteria, key)
    )
  ) {
    throw new HttpError(502, 'ai_decide returned probabilities for unknown candidates. No action was applied.');
  }
  return answers;
}

export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(quantile * ordered.length) - 1)];
}
