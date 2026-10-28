import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingEvent } from '../videos/entities/video-processing-event.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793200624302 } from './migrations/1793200624302-CreateVideos';
import { AddVideosChannelIdIndex1793201853195 } from './migrations/1793201853195-AddVideosChannelIdIndex';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
  'video_processing_events',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video, VideoProcessingEvent],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1793200624302,
          AddVideosChannelIdIndex1793201853195,
        ],
      },
    );

    await dataSource.initialize();

    await Promise.all([
      ...MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
      dataSource.query(
        `DROP TYPE IF EXISTS "verification_tokens_type_enum" CASCADE`,
      ),
      dataSource.query(`DROP TYPE IF EXISTS "videos_status_enum" CASCADE`),
      dataSource.query(
        `DROP TYPE IF EXISTS "video_processing_events_status_enum" CASCADE`,
      ),
    ]);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all six tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(4);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'video_processing_events',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the channel_id index', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'videos' AND indexdef ILIKE '%channel_id%'`,
    );
    expect(result).toHaveLength(0);
  });
});
