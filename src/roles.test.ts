import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rolesFor } from './roles.js';

const can = (role: string, method: string, path: string) => rolesFor(method, path).includes(role as never);

describe("droits sur l'administration", () => {
  it("l'arbitre tranche les matchs, et rien d'autre", () => {
    assert.equal(can('arbitre', 'GET', '/overview'), true);
    assert.equal(can('arbitre', 'GET', '/disputes'), true);
    assert.equal(can('arbitre', 'GET', '/matches'), true);
    assert.equal(can('arbitre', 'GET', '/corrections'), false);
    assert.equal(can('staff', 'GET', '/corrections'), false);
    assert.equal(can('admin', 'GET', '/corrections'), true);
    assert.equal(can('arbitre', 'GET', '/arbitrations'), true);
    assert.equal(can('arbitre', 'POST', '/arbitrations/12'), true);
    assert.equal(can('arbitre', 'POST', '/matches/3f2b1c9e-1111-2222-3333-444455556666/cancel'), true);
    assert.equal(can('arbitre', 'GET', '/reports'), false);
    assert.equal(can('arbitre', 'GET', '/players'), false);
    assert.equal(can('arbitre', 'POST', '/players/abc/sanctions'), false);
    assert.equal(can('arbitre', 'POST', '/events'), false);
  });

  it('le staff modère et sanctionne, sans gérer le site', () => {
    for (const [method, path] of [['GET', '/disputes'], ['GET', '/reports'], ['POST', '/reports/4'], ['GET', '/players'], ['GET', '/players/abc/sanctions'], ['POST', '/players/abc/sanctions'], ['POST', '/sanctions/9/lift']]) {
      assert.equal(can('staff', method!, path!), true, `${method} ${path}`);
    }
    for (const [method, path] of [['POST', '/players/abc/role'], ['POST', '/players/abc/badges'], ['POST', '/players/abc/unban'], ['POST', '/events'], ['PATCH', '/events/1'], ['POST', '/season/close'], ['POST', '/founders'], ['POST', '/discord/sync-roles']]) {
      assert.equal(can('staff', method!, path!), false, `${method} ${path}`);
    }
  });

  it("l'admin a accès à tout, un membre à rien", () => {
    for (const [method, path] of [['GET', '/disputes'], ['GET', '/reports'], ['POST', '/players/abc/sanctions'], ['POST', '/players/abc/role'], ['POST', '/season/close']]) {
      assert.equal(can('admin', method!, path!), true);
      assert.equal(can('member', method!, path!), false);
    }
  });
});
