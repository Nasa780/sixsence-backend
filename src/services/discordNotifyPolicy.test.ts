import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NOTIFY_CHOICES, notifyPanelMessage, notifyReply, parseNotifyChoice } from './discordNotifyPolicy.js';

describe('panneau des notifications Discord', () => {
  it('reconnaît ses boutons et ignore les autres', () => {
    assert.equal(parseNotifyChoice('notif:gta')?.label, 'Événements GTA');
    assert.equal(parseNotifyChoice('notif:inconnu'), null);
    assert.equal(parseNotifyChoice('ticket:open:bug'), null);
    assert.equal(parseNotifyChoice(undefined), null);
  });

  it('tient dans une rangée de 5 boutons, chaque bouton étant reconnu', () => {
    const buttons = notifyPanelMessage().components[0]!.components;
    assert.ok(buttons.length <= 5);
    assert.deepEqual(buttons.map((button) => parseNotifyChoice(button.custom_id)?.type), NOTIFY_CHOICES.map((choice) => choice.type));
  });

  it('confirme l’activation et la coupure', () => {
    const choice = NOTIFY_CHOICES[0]!;
    assert.match(notifyReply(choice, true), /activé/);
    assert.match(notifyReply(choice, false), /coupé/);
  });
});
