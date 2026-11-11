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
      [
        User,
        Channel,
        RefreshToken,
        VerificationToken,
        Video,
        VideoProcessingEvent,
      ],
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

    // Dropped sequentially, not via Promise.all: concurrent CASCADE drops
    // across FK-related tables (e.g. channels -> videos) run on different
    // pool connections and can deadlock against each other in Postgres.
    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(`DROP TYPE IF EXISTS "videos_status_enum" CASCADE`);
    await dataSource.query(
      `DROP TYPE IF EXISTS "video_processing_events_status_enum" CASCADE`,
    );
  });

  afterAll(async () => {
    // The last two tests undo all three non-base migrations in turn (the
    // channel_id index, CreateVideos, then CreateAuthTokens), leaving the
    // videos and token tables missing. Re-apply so the shared DB is fully
    // migrated when subsequent suites run.
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

  it('should revert CreateAuthTokens and drop the token tables', async () => {
    // Two more migrations sit between the already-undone index migration
    // and CreateAuthTokens (CreateVideos, then CreateAuthTokens itself) —
    // CreateAuthTokens used to be the last migration this suite covered
    // before SI-03.2 added the videos migrations after it; without walking
    // back both, CreateAuthTokens.down() would have no test coverage at all.
    await dataSource.undoLastMigration(); // undoes CreateVideos
    await dataSource.undoLastMigration(); // undoes CreateAuthTokens

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
