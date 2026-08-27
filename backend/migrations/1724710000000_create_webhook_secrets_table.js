exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('webhook_secrets', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    subscriber_id: {
      type: 'uuid',
      notNull: true,
      references: 'webhook_subscribers(id)',
      onDelete: 'CASCADE',
    },
    secret: {
      type: 'text',
      notNull: true,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    rotated_at: {
      type: 'timestamp',
    },
  });

  pgm.createIndex('webhook_secrets', ['subscriber_id', 'is_active']);
  pgm.createIndex('webhook_secrets', ['created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('webhook_secrets');
};
