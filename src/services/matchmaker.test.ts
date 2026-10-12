import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMatch, membersOf, type QueueGroup } from './matchmaker.js';

/** Construit une file : tailles des groupes dans l'ordre d'arrivée. */
function queue(...sizes: number[]): QueueGroup[] {
  let player = 0;
  return sizes.map((size, index) => ({
    id: `g${index}`,
    members: Array.from({ length: size }, () => `p${(player += 1)}`),
    joinedAt: 1000 + index,
  }));
}

/** Vérifie les invariants d'une proposition de match. */
function check(groups: QueueGroup[], teamSize: number) {
  const match = findMatch(groups, teamSize);
  assert.ok(match, 'un match était attendu');
  const a = membersOf(match.teamA);
  const b = membersOf(match.teamB);
  assert.equal(a.length, teamSize, 'équipe 1 complète');
  assert.equal(b.length, teamSize, 'équipe 2 complète');
  assert.equal(new Set([...a, ...b]).size, teamSize * 2, 'aucun joueur en double');
  return match;
}

const ids = (groups: QueueGroup[]) => groups.map((group) => group.id).sort();

describe('findMatch', () => {
  it('ne crée rien sans assez de joueurs', () => {
    assert.equal(findMatch(queue(1, 1, 1), 2), null);
    assert.equal(findMatch([], 5), null);
  });

  it('2v2 avec quatre solos', () => {
    const match = check(queue(1, 1, 1, 1), 2);
    assert.deepEqual([...ids(match.teamA), ...ids(match.teamB)].sort(), ['g0', 'g1', 'g2', 'g3']);
  });

  it('2v2 : un duo contre deux solos', () => {
    const match = check(queue(2, 1, 1), 2);
    assert.deepEqual(ids(match.teamA), ['g0']);
    assert.deepEqual(ids(match.teamB), ['g1', 'g2']);
  });

  it('ne sépare jamais un groupe', () => {
    const groups = queue(3, 2, 2, 3);
    const match = check(groups, 5);
    for (const group of groups) {
      const inA = match.teamA.includes(group);
      const inB = match.teamB.includes(group);
      assert.ok(!(inA && inB));
    }
  });

  it('sert toujours le groupe le plus ancien', () => {
    const match = check(queue(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1), 5);
    const chosen = [...ids(match.teamA), ...ids(match.teamB)];
    assert.ok(chosen.includes('g0'));
    // Les dix plus anciens solos sont choisis, pas les deux derniers.
    assert.ok(!chosen.includes('g10') && !chosen.includes('g11'));
  });

  it('5v5 : une équipe complète contre cinq solos', () => {
    const match = check(queue(5, 1, 1, 1, 1, 1), 5);
    assert.deepEqual(ids(match.teamA), ['g0']);
    assert.equal(match.teamB.length, 5);
  });

  it('5v5 : 4 + 1 de chaque côté', () => {
    check(queue(4, 4, 1, 1), 5);
  });

  it('3v3 : un trio contre trois solos', () => {
    const match = check(queue(3, 1, 1, 1), 3);
    assert.deepEqual(ids(match.teamA).length === 1 ? ids(match.teamA) : ids(match.teamB), ['g0']);
  });

  it('4v4 : 3 + 1 contre 2 + 2', () => {
    const match = check(queue(3, 2, 2, 1), 4);
    assert.equal(ids(match.teamA).length + ids(match.teamB).length, 4);
  });

  it("4v4 : un groupe de 3 attend un solo plutôt que d'être séparé", () => {
    assert.equal(findMatch(queue(3, 3, 2), 4), null);
  });

  it('trouve une combinaison quand le placement naïf échoue', () => {
    // Placement « au plus vide » : 3 | 2, puis 2 -> B (4), puis 3 ne rentre plus.
    // La recherche doit trouver 3+2 | 2+3.
    check(queue(3, 2, 2, 3), 5);
  });

  it("passe un groupe impossible à placer sans bloquer la file", () => {
    // Un groupe de 4 en tête, mais aucun solo pour le compléter ; derrière, 2+3 contre 2+3.
    const match = check(queue(4, 2, 3, 2, 3), 5);
    const chosen = [...ids(match.teamA), ...ids(match.teamB)].sort();
    assert.deepEqual(chosen, ['g1', 'g2', 'g3', 'g4']);
  });

  it('renvoie null quand aucune combinaison exacte n\'existe', () => {
    // Que des duos en 5v5 : impossible de faire 5.
    assert.equal(findMatch(queue(2, 2, 2, 2, 2, 2), 5), null);
  });

  it('ignore les groupes trop grands pour le format', () => {
    const match = check(queue(3, 1, 1, 1, 1), 2);
    assert.ok(![...ids(match.teamA), ...ids(match.teamB)].includes('g0'));
  });

  it('reste rapide avec une grande file', () => {
    const sizes = Array.from({ length: 200 }, (_, index) => [1, 2, 3, 4][index % 4] ?? 1);
    const started = Date.now();
    check(queue(...sizes), 5);
    assert.ok(Date.now() - started < 500);
  });

  it('files aléatoires : toujours valide, et trouve un match dès qu\'il en existe un', () => {
    // Recherche exhaustive de référence : chaque groupe va en A, en B ou reste en file.
    const exists = (sizes: number[], teamSize: number): boolean => {
      const walk = (i: number, a: number, b: number): boolean => {
        if (a === teamSize && b === teamSize) return true;
        if (i === sizes.length) return false;
        const s = sizes[i] ?? 0;
        return (a + s <= teamSize && walk(i + 1, a + s, b)) || (b + s <= teamSize && walk(i + 1, a, b + s)) || walk(i + 1, a, b);
      };
      return walk(0, 0, 0);
    };

    let seed = 42;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 3000; round += 1) {
      const teamSize = 2 + Math.floor(random() * 4); // 2v2, 3v3, 4v4 ou 5v5
      const count = 1 + Math.floor(random() * 9);
      const sizes = Array.from({ length: count }, () => 1 + Math.floor(random() * teamSize));
      const groups = queue(...sizes);
      const match = findMatch(groups, teamSize);
      if (match) {
        assert.equal(membersOf(match.teamA).length, teamSize);
        assert.equal(membersOf(match.teamB).length, teamSize);
        assert.equal(new Set([...match.teamA, ...match.teamB]).size, match.teamA.length + match.teamB.length);
      }
      assert.equal(Boolean(match), exists(sizes, teamSize), `file ${sizes.join(',')} en ${teamSize}v${teamSize}`);
    }
  });

  it('1v1 de test', () => {
    check(queue(1, 1), 1);
    assert.equal(findMatch(queue(1), 1), null);
  });
});
