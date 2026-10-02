/**
 * Per-user AI chat conversation group (multi-tenant).
 *
 * One row = one user-created sidebar folder ("分组") that conversations can be
 * filed into via `Conversation.group_id`. Pure organizational container: no
 * transcript, no runtime state. Deleting a group leaves its conversations
 * intact — conversationStore.removeGroup clears the dangling group_id first.
 *
 * @pattern Value Object
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ConversationGroup = sequelize.define('ConversationGroup', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this group',
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    defaultValue: '新建分组',
    comment: 'Human-friendly folder name shown in the chat sidebar',
  },
  sortOrder: {
    type: DataTypes.INTEGER,
    allowNull: true,
    field: 'sort_order',
    comment: 'Manual folder position (smaller = higher); null = after ordered groups',
  },
}, {
  tableName: 'ai_conversation_groups',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
  ],
});

module.exports = ConversationGroup;
