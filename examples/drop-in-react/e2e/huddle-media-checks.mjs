// Independently authored lifecycle checks adopted by the real-media acceptance
// case. Passing evidence requires execution of the final spec.

// A. Before the existing successful Flutter screen-share step:
async function screenDenialAndConflict({ flutter, react, checkpoint, expect, observations }) {
  await flutter.evaluate(() => {
    window.__media.display = navigator.mediaDevices.getDisplayMedia;
    navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await flutter.getByLabel('Start screen sharing', { exact: true }).click();
  await expect(flutter.getByLabel('Dialog', { exact: true }).getByText(/Screen sharing permission was denied/)).toBeVisible();
  expect((await checkpoint('display-denied')).sessions[0].screen_share_owner_user_id).toBeNull();
  await flutter.evaluate(() => { navigator.mediaDevices.getDisplayMedia = window.__media.display; });

  await react.getByRole('button', { name: 'Open huddle details', exact: true }).click();
  await react.getByLabel('Start screen sharing', { exact: true }).click();
  await expect.poll(async () => (await checkpoint('react-share-owner')).sessions[0].screen_share_owner_user_id).toBe('ada');
  // Flutter current provider API permits initiating capture before the server
  // rejects ownership conflict. Verify the prepared capture is released.
  const before = await flutter.evaluate(() => window.__media.tracks.filter(t => t.kind === 'video').length);
  const denied = flutter.waitForResponse(response => /\/huddles\/[^/]+\/screen-share$/.test(new URL(response.url()).pathname) && response.request().method() === 'PATCH');
  await flutter.getByLabel('Start screen sharing', { exact: true }).click();
  expect((await denied).status()).toBe(409);
  await expect.poll(() => flutter.evaluate(() => window.__media.tracks.filter(t => t.kind === 'video').length)).toBeGreaterThan(before);
  await expect.poll(() => flutter.evaluate(() => window.__media.tracks.filter(t => t.kind === 'video').every(t => t.readyState === 'ended'))).toBe(true);
  expect((await checkpoint('share-conflict-cleanup')).sessions[0].screen_share_owner_user_id).toBe('ada');
  observations.push({ label: 'screen-denied-and-ownership-conflict', permission: 'injected denial', conflict: 'real HTTP 409', preparedCapture: 'actual browser video track ended', canonicalOwner: 'ada' });
  await react.getByLabel('Stop screen sharing', { exact: true }).click();
  await expect.poll(async () => (await checkpoint('react-share-released')).sessions[0].screen_share_owner_user_id).toBeNull();
  await react.keyboard.press('Escape');
}

// B. After rejoin RTP assertion, before final host End. Mutation is confined to
// the harness's isolated canonical schema. It tests real media authorizer,
// not the conversation-member HTTP command (covered separately by SDK tests).
async function canonicalRevocation({ flutter, react, chatLab, chatLabOrigin, checkpoint, stopped, expect, observations }) {
  await flutter.getByLabel('Start screen sharing', { exact: true }).click();
  await expect.poll(async () => (await checkpoint('flutter-sharing-before-revocation')).sessions[0].screen_share_owner_user_id).toBe('grace');
  await expect.poll(() => react.getByLabel('Grace Hopper shared screen', { exact: true }).evaluate(video => video.videoWidth > 0 && video.currentTime > 0)).toBe(true);
  const sessions = (await chatLab.harness.pool.query("SELECT id, tenant_id, conversation_id FROM chat_huddle_sessions WHERE status='active' ORDER BY id")).rows;
  expect(sessions).toHaveLength(1);
  const session = sessions[0];
  const changed = await chatLab.harness.pool.query("UPDATE chat_conversation_members SET state='removed', updated_at=clock_timestamp() WHERE tenant_id=$1 AND conversation_id=$2 AND user_id=$3 AND state='active' RETURNING user_id,state", [session.tenant_id, session.conversation_id, 'grace']);
  expect(changed.rows).toEqual([{ user_id: 'grace', state: 'removed' }]);
  try {
    await expect.poll(() => stopped(flutter), { timeout: 15_000 }).toBe(true);
  } catch (error) {
    await checkpoint('revocation-resource-assertion-failed');
    const resources = await Promise.race([
      flutter.evaluate(() => ({
        peers: window.__media.pcs.map(pc => pc.connectionState),
        tracks: window.__media.tracks.map(track => ({ kind: track.kind, state: track.readyState })),
        sockets: window.__media.sockets.map(socket => socket.readyState),
      })).catch(() => ({ unavailable: 'page evaluation failed' })),
      new Promise(resolve => setTimeout(() => resolve({ unavailable: 'page evaluation exceeded 2000ms' }), 2000)),
    ]);
    observations.push({ label: 'revocation-resource-assertion-failed', resources });
    throw error;
  }
  await expect.poll(async () => { const value = await checkpoint('revoked-active-share-cleanup'); return value.sessions[0].screen_share_owner_user_id === null && value.participants.find(p => p.user_id === 'grace').joined === false; }, { timeout: 18_000 }).toBe(true);
  await expect(react.getByLabel('Grace Hopper shared screen', { exact: true })).toHaveCount(0);
  observations.push({ label: 'flutter-active-share-permission-revocation', canonicalParticipationLeft: true, canonicalOwnerReleased: true, remoteVideoRemoved: true });
  // No token/descriptor retained. Fixed deterministic test credential stays
  // within request headers and is never included in report/network body logs.
  const credential = chatLab.actors.find(actor => actor.id === 'grace').credential;
  const response = await flutter.request.post(`${chatLabOrigin}/api/chat/huddles/${encodeURIComponent(session.id)}/join`, {
    headers: { authorization: `Bearer ${credential}`, 'idempotency-key': 'qa-revoked-member-rejoin' },
    data: { operation: 'join_huddle', huddleSessionId: session.id, idempotencyKey: 'qa-revoked-member-rejoin' },
  });
  expect(response.status()).toBe(403);
  observations.push({ label: 'canonical-member-revoked', canonicalMember: changed.rows[0], transportClosed: true, rejoinHttpStatus: response.status(), permissionSource: 'isolated PostgreSQL membership' });
  await checkpoint('canonical-member-revoked');
  // Restoration is explicit fixture teardown. Final End still removes sessions.
  await chatLab.harness.pool.query("UPDATE chat_conversation_members SET state='active', updated_at=clock_timestamp() WHERE tenant_id=$1 AND conversation_id=$2 AND user_id=$3 AND state='removed'", [session.tenant_id, session.conversation_id, 'grace']);
}

export { screenDenialAndConflict, canonicalRevocation };

// C. After first successful exchange/recovery, before revocation/end. Flutter
// uses a full navigation for actor switching; this validates that supported
// host boundary, not in-place account replacement or native lifecycle.
async function flutterAccountRoundTrip({ flutter, react, status, stats, checkpoint, expect, observations }) {
  await flutter.getByLabel('Start screen sharing', { exact: true }).click();
  await expect.poll(async () => (await checkpoint('flutter-sharing-before-account-switch')).sessions[0].screen_share_owner_user_id).toBe('grace');
  await expect.poll(() => react.getByLabel('Grace Hopper shared screen', { exact: true }).evaluate(video => video.videoWidth > 0 && video.currentTime > 0)).toBe(true);
  // Tap the modal barrier; Escape is not handled by this Flutter web sheet.
  const beforeDismiss = (await stats(flutter)).reduce((a, b) => a + b, 0);
  await flutter.mouse.click(12, 24);
  await expect(flutter.getByLabel('Dialog', { exact: true })).toHaveCount(0);
  await expect.poll(async () => { const values = await stats(flutter); return values.length === 2 && values.reduce((a, b) => a + b, 0) > beforeDismiss; }).toBe(true);
  observations.push({ label: 'closing-controls-preserves-media', inboundBytes: await stats(flutter) });
  await flutter.getByRole('button', { name: 'Grace Hopper', exact: true }).click();
  await flutter.getByRole('menuitem', { name: 'Margaret Hamilton', exact: true }).click();
  await flutter.waitForURL(/actor=margaret/);
  await flutter.waitForFunction(() => typeof window.handrailBackendLab === 'function');
  await expect.poll(async () => (await status(flutter)).identity?.userId).toBe('margaret');
  await flutter.locator('flt-semantics-placeholder').evaluate(e => e.click());
  await expect.poll(() => react.locator('[data-media-connection="connected"]').count()).toBe(1);
  await expect.poll(async () => { const value = await checkpoint('active-share-account-switch-cleanup'); return value.sessions[0].screen_share_owner_user_id === null && value.participants.find(p => p.user_id === 'grace').joined === false; }, { timeout: 18_000 }).toBe(true);
  await expect(react.getByLabel('Grace Hopper shared screen', { exact: true })).toHaveCount(0);
  observations.push({ label: 'flutter-active-share-account-switch', canonicalParticipationLeft: true, canonicalOwnerReleased: true, remoteVideoRemoved: true });
  expect(await flutter.evaluate(() => ({ peers: window.__media.pcs.length, tracks: window.__media.tracks.length }))).toEqual({ peers: 0, tracks: 0 });
  observations.push({ label: 'flutter-account-switch', mechanism: 'supported actor selector document navigation', identity: 'margaret', oldGracePeerReleased: true, newAccountCaptureCountBeforeJoin: 0 });
  await flutter.getByRole('button', { name: 'Margaret Hamilton', exact: true }).click();
  await flutter.getByRole('menuitem', { name: 'Grace Hopper', exact: true }).click();
  await flutter.waitForURL(/actor=grace/);
  await flutter.waitForFunction(() => typeof window.handrailBackendLab === 'function');
  await expect.poll(async () => (await status(flutter)).identity?.userId).toBe('grace');
  await flutter.locator('flt-semantics-placeholder').evaluate(e => e.click());
  await expect.poll(async () => { const value = await status(flutter); return value.realtime === 'connected' && value.huddle?.hydration === 'ready'; }).toBe(true);
  await flutter.getByRole('button', { name: /Huddle · Chat Lab General/ }).click();
  // Navigation discarded the private descriptor, not canonical membership.
  if ((await status(flutter)).huddle.participation === 'joined') {
    await flutter.getByRole('button', { name: 'Leave huddle', exact: true }).click();
    await expect.poll(async () => (await checkpoint('account-return-left')).participants.find(p => p.user_id === 'grace').joined).toBe(false);
  }
  await flutter.getByRole('button', { name: 'Join huddle', exact: true }).click();
  await flutter.getByLabel('Unmute microphone', { exact: true }).click();
  await expect.poll(async () => { const values = await stats(flutter); return values.length === 2 && values.every(n => n > 1000); }).toBe(true);
  observations.push({ label: 'flutter-account-return', identity: 'grace', inboundBytes: await stats(flutter) });
}
export { flutterAccountRoundTrip };
