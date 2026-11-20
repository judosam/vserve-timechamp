/**
 * Legacy Compatibility & Existing REA Telemetry API Test Suite
 * Tests existing client, agent, and administrator endpoints in admin/server.js
 * Framework: node:test & node:assert
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiClient,
  PREDEFINED_USERS,
  assertStatus,
  assertSuccess,
  assertError,
  assertSchema,
  ensureServerRunning,
  stopManagedServer
} = require('./helpers');

describe('Legacy Compatibility & Client Endpoints', () => {
  let client;
  let adminToken;

  before(async () => {
    await ensureServerRunning();
    client = new ApiClient();
  });

  after(() => {
    stopManagedServer();
  });

  describe('1. Administrator Authentication & Session Verification', () => {
    it('POST /api/admin/login - Authenticates existing administrator "Samuel P" and issues adm_ token', async () => {
      const res = await client.post('/api/admin/login', {
        username: PREDEFINED_USERS.LEGACY_ADMIN.username,
        password: PREDEFINED_USERS.LEGACY_ADMIN.password
      });

      assertStatus(res, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.token, 'Expected token in login response');
      assert.ok(res.data.token.startsWith('adm_'), 'Legacy admin token should start with adm_');
      assert.ok(res.data.user, 'Expected user profile in login response');
      assert.equal(res.data.user.username, 'Samuel P');
      adminToken = res.data.token;
      client.setAdminToken(adminToken);
      client.setToken(adminToken);
    });

    it('POST /api/admin/login - Rejects invalid credentials with 401 Unauthorized', async () => {
      const res = await client.post('/api/admin/login', {
        username: 'non.existent.user',
        password: 'WrongPassword@123'
      });

      assertStatus(res, 401);
      assert.equal(res.data.success, false);
      assert.ok(res.data.error, 'Expected error message on invalid credentials');
    });

    it('GET /api/admin/check - Verifies valid admin session with Bearer token header', async () => {
      const res = await client.get('/api/admin/check', {
        token: adminToken
      });

      assertStatus(res, 200);
      assert.ok(res.data.authenticated === true || res.data.success === true);
      assert.ok(res.data.user);
      assert.equal(res.data.user.username, 'Samuel P');
    });

    it('GET /api/admin/check - Verifies valid admin session with X-Admin-Token header', async () => {
      const res = await client.get('/api/admin/check', {
        headers: { 'X-Admin-Token': adminToken },
        token: null
      });

      assertStatus(res, 200);
      assert.ok(res.data.authenticated === true || res.data.success === true);
      assert.ok(res.data.user);
      assert.equal(res.data.user.username, 'Samuel P');
    });

    it('GET /api/admin/check - Rejects unauthenticated request with 401 Unauthorized', async () => {
      const res = await client.get('/api/admin/check', {
        token: null,
        adminToken: null
      });

      assertStatus(res, 401);
      assert.ok(res.data.authenticated === false || res.data.success === false);
    });
  });

  describe('2. Client & Agent Telemetry Ingestion Endpoints', () => {
    it('GET /api/client/version - Returns client version, sha256 hash, and download URL', async () => {
      const res = await client.get('/api/client/version');

      assertStatus(res, 200);
      assert.ok(res.data.version, 'Expected version field');
      assert.equal(typeof res.data.sha256, 'string');
      assert.ok(res.data.downloadUrl, 'Expected downloadUrl in response');
    });

    it('GET /api/client/roster - Returns sanitized employee roster for client login selector', async () => {
      const res = await client.get('/api/client/roster');

      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected array of roster users');
      assert.ok(res.data.length > 0, 'Roster should contain installed users');
      for (const u of res.data) {
        assert.ok(u.username, 'User must have username');
        assert.ok(u.displayName, 'User must have displayName');
        assert.equal(typeof u.password, 'undefined', 'Password must NOT be leaked in roster');
      }
    });

    it('POST /api/client/login - Authenticates workstation agent with machine name and user', async () => {
      const res = await client.post('/api/client/login', {
        username: PREDEFINED_USERS.LEGACY_ADMIN.username,
        password: PREDEFINED_USERS.LEGACY_ADMIN.password,
        machineName: 'TEST-DEV-MACHINE'
      });

      assertStatus(res, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.user);
      assert.equal(res.data.user.username, 'Samuel P');
    });

    it('POST /api/heartbeat - Ingests live tracking heartbeat telemetry', async () => {
      const heartbeatPayload = {
        user: 'Samuel P',
        machine: 'TEST-DEV-MACHINE',
        status: 'Active',
        activeSeconds: 3600,
        idleSeconds: 120,
        productiveSeconds: 3400,
        unproductiveSeconds: 200,
        prodPct: 94,
        currentApp: 'code.exe',
        windowTitle: 'Vserve-TimeChamp - Visual Studio Code',
        url: 'https://github.com/vserve/timechamp',
        timestamp: new Date().toISOString()
      };

      const res = await client.post('/api/heartbeat', heartbeatPayload);

      assertStatus(res, 200);
      assert.equal(res.data.status, 'ok');
    });

    it('POST /api/heartbeat - Accepts minimal valid heartbeat payload', async () => {
      const minimalPayload = {
        user: 'sarah.m',
        machine: 'QA-LAPTOP-01',
        status: 'Active',
        activeSeconds: 60,
        idleSeconds: 0
      };

      const res = await client.post('/api/heartbeat', minimalPayload);

      assertStatus(res, 200);
      assert.equal(res.data.status, 'ok');
    });
  });

  describe('3. Protected Reporting, Devices & Analytics Endpoints', () => {
    it('GET /api/devices - Returns device fleet inventory with admin token', async () => {
      const res = await client.get('/api/devices', {
        adminToken
      });

      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected array of devices');
      if (res.data.length > 0) {
        const dev = res.data[0];
        assert.ok(dev.machineName, 'Device must include machineName');
        assert.ok(dev.status, 'Device must include status');
      }
    });

    it('GET /api/devices - Rejects unauthenticated request with 401', async () => {
      const res = await client.get('/api/devices', {
        token: null,
        adminToken: null
      });

      assertStatus(res, 401);
    });

    it('GET /api/live - Returns real-time active users telemetry with admin token', async () => {
      const res = await client.get('/api/live', {
        adminToken
      });

      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected array of live users');
      const found = res.data.find(u => u.user === 'Samuel P');
      assert.ok(found, 'Expected user "Samuel P" to appear in live users following heartbeat');
      assert.equal(found.currentApp, 'code.exe');
    });

    it('GET /api/analytics - Returns aggregated workforce productivity analytics', async () => {
      const res = await client.get('/api/analytics', {
        adminToken
      });

      assertStatus(res, 200);
      assert.ok(res.data, 'Expected analytics object');
      assert.ok(Array.isArray(res.data.applications), 'Analytics must include applications array');
      assert.ok(Array.isArray(res.data.websites), 'Analytics must include websites array');
    });

    it('GET /api/reports - Returns report records for administrative dashboard', async () => {
      const res = await client.get('/api/reports', {
        adminToken
      });

      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected array of report records');
    });

    it('GET /api/config - Rejects unauthenticated access with 401', async () => {
      const res = await client.get('/api/config', {
        token: null,
        adminToken: null
      });

      assertStatus(res, 401);
    });

    it('GET /api/config - Returns configuration settings when authenticated', async () => {
      const res = await client.get('/api/config', {
        adminToken
      });

      assertStatus(res, 200);
      assert.ok(res.data.agent, 'Expected agent configuration');
      assert.ok(typeof res.data.agent.idleThresholdSeconds === 'number', 'Expected numeric idle threshold');
    });

    it('POST /api/config - Saves updated configuration and returns success', async () => {
      const updatePayload = {
        agent: {
          idleThresholdSeconds: 300
        }
      };

      const res = await client.post('/api/config', updatePayload, {
        adminToken
      });

      assertStatus(res, 200);
      assert.equal(res.data.success, true);
    });
  });

  describe('4. Session Logout & Revocation', () => {
    it('POST /api/admin/logout - Revokes administrator session token', async () => {
      const res = await client.post('/api/admin/logout', {}, {
        adminToken
      });

      assertStatus(res, 200);
      assert.equal(res.data.success, true);

      // Verify token is now invalid
      const checkRes = await client.get('/api/admin/check', {
        adminToken
      });
      assertStatus(checkRes, 401);
    });
  });
});
