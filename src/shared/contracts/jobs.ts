import { z } from 'zod';

export const PLATFORMS = ['youtube', 'instagram', 'tiktok', 'facebook'] as const;
export const Platform = z.enum(PLATFORMS);

export const RenderConfig = z.object({
  width: z.number().int().min(240).max(7680).default(1080), height: z.number().int().min(240).max(7680).default(1920),
  fps: z.number().min(1).max(120).default(30), codec: z.enum(['h264', 'h265']).default('h264'),
  bitrateKbps: z.number().int().min(200).max(100000).default(8000), format: z.enum(['mp4', 'mov']).default('mp4'),
  audioBitrateKbps: z.number().int().min(32).max(512).default(160),
}).default({ width: 1080, height: 1920, fps: 30, codec: 'h264', bitrateKbps: 8000, format: 'mp4', audioBitrateKbps: 160 });

export const CreateJobInput = z.object({
  name: z.string().trim().min(1).max(120),
  projectId: z.string().trim().regex(/^[\w-]{1,64}$/).default('default'),
  sourcePath: z.string().min(1).max(1024),
  platforms: z.array(Platform).max(4).default([]),
  priority: z.number().int().min(0).max(9).default(5),
  config: z.object({ cut: z.object({ startSec: z.number().min(0).optional(), durationSec: z.number().min(0.5).max(3600).optional() }).default({}), subtitleLang: z.string().max(16).default('pt'), render: RenderConfig }).default({ cut: {}, subtitleLang: 'pt', render: RenderConfig.parse(undefined) }),
});
export type CreateJobInput = z.infer<typeof CreateJobInput>;

export const JobAction = z.object({ jobId: z.string().min(1).max(128), action: z.enum(['pause', 'resume', 'cancel', 'retry']) });
export const ApprovalDecision = z.object({ jobId: z.string().min(1).max(128), decision: z.enum(['approve', 'reject']), note: z.string().max(2000).default(''), user: z.string().min(1).max(64).default('operador') });

export interface JobRow {
  id: string; name: string; projectId: string; sourcePath: string; currentPath: string; stationId: string; employeeId: string;
  state: string; progress: number; createdAt: string; startedAt: string | null; completedAt: string | null;
  config: unknown; platforms: string[]; priority: number; attempts: number; error: string | null;
}
