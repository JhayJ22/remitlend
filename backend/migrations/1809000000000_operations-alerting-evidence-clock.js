'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('alert_ownership', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      slo_key: {
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      owner: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      severity: {
        type: DataTypes.ENUM('critical', 'high', 'medium', 'low'),
        allowNull: false,
        defaultValue: 'critical',
      },
      runbook_url: {
        type: DataTypes.STRING(2048),
        allowNull: false,
      },
      escalation_route: {
        type: DataTypes.STRING(512),
        allowNull: false,
      },
      slo_definition: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('alert_ownership', {
      fields: ['slo_key'],
      type: 'unique',
      name: 'alert_ownership_slo_key_unique',
    });

    await queryInterface.createTable('alert_drill_runs', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      slo_key: {
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'notified', 'acknowledged', 'recovered', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      notification_sent_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      acknowledged_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      recovered_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      idempotency_key: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('alert_drill_runs', {
      fields: ['idempotency_key'],
      type: 'unique',
      name: 'alert_drill_runs_idempotency_key_unique',
    });

    await queryInterface.addIndex('alert_drill_runs', ['slo_key'], {
      name: 'alert_drill_runs_slo_key_idx',
    });

    await queryInterface.createTable('incident_evidence_bundles', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      incident_id: {
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      bundle_json: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      redaction_level: {
        type: DataTypes.ENUM('default', 'minimal', 'none'),
        allowNull: false,
        defaultValue: 'default',
      },
      access_scope: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('incident_evidence_bundles', {
      fields: ['incident_id'],
      type: 'unique',
      name: 'incident_evidence_bundles_incident_id_unique',
    });

    await queryInterface.addIndex('incident_evidence_bundles', ['expires_at'], {
      name: 'incident_evidence_bundles_expires_at_idx',
    });

    await queryInterface.createTable('clock_skew_samples', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      source: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      observed_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      authoritative_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      drift_ms: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('clock_skew_samples', ['observed_at'], {
      name: 'clock_skew_samples_observed_at_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('clock_skew_samples');
    await queryInterface.dropTable('incident_evidence_bundles');
    await queryInterface.dropTable('alert_drill_runs');
    await queryInterface.dropTable('alert_ownership');
  },
};