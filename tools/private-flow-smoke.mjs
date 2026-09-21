import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
const { fetch, AbortSignal } = globalThis;

// Explicit opt-in: creates only disposable private guests, then deletes both.
assert.equal(process.env.RUN_PRIVATE_SMOKE, '1');
const origin = process.env.SMOKE_ORIGIN ?? 'http://127.0.0.1:8787';
assert.ok(['http://127.0.0.1:8787', 'https://whatthemake.ru'].includes(origin));
const sessions = [];
async function request(
  path,
  { cookie, method = 'GET', body, status = 200 } = {},
) {
  const response = await fetch(origin + path, {
    method,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  return response;
}
try {
  for (let index = 0; index < 2; index += 1) {
    const response = await request('/api/v1/guest-sessions', {
      method: 'POST',
      status: 201,
    });
    const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
    assert.ok(cookie);
    sessions.push(cookie);
  }
  const cookie = sessions[0];
  const snapshots = [];
  for (const [index, gtin] of ['9999999999994', '5901234123457'].entries()) {
    const { observation } = await (
      await request('/api/v1/product-observations', {
        cookie,
        method: 'POST',
        status: 201,
        body: { gtin },
      })
    ).json();
    const base = '/api/v1/product-observations/' + observation.observationId;
    const { revision } = await (
      await request(base + '/inci-revisions', {
        cookie,
        method: 'POST',
        status: 201,
        body: {
          kind: 'USER_TRANSCRIPTION',
          sourceText: index === 0 ? 'Aqua, Mica' : 'Aqua, Beeswax',
        },
      })
    ).json();
    const input = {
      category: 'MASCARA',
      identityConfirmed: true,
      identity: {
        brandName: 'WTM private smoke',
        familyName: 'Mascara',
        variantName: 'Disposable ' + index,
        shadeName: null,
        netQuantity: { value: '8.5', unit: 'MILLILITER' },
        isWaterproof: index === 0,
      },
      revisionId: revision.revisionId,
      formulaComplete: index !== 0,
      claimKinds: index === 0 ? ['VOLUME'] : [],
      priceKopecks: 59990,
    };
    const { snapshot } = await (
      await request(base + '/private-snapshots', {
        cookie,
        method: 'POST',
        status: 201,
        body: input,
      })
    ).json();
    snapshots.push(snapshot);
    assert.equal(snapshot.revision.sourceSha256, revision.sourceSha256);
    assert.equal(snapshot.identitySource, 'USER_CONFIRMED_PACKAGING');
    assert.equal(snapshot.formulaComplete, index !== 0);
    const duplicate = await (
      await request(base + '/private-snapshots', {
        cookie,
        method: 'POST',
        body: input,
      })
    ).json();
    assert.equal(duplicate.resultKind, 'REUSED');
    assert.equal(duplicate.snapshot.snapshotId, snapshot.snapshotId);
    const analysis = await (
      await request(
        base + '/inci-revisions/' + revision.revisionId + '/analysis',
        { cookie },
      )
    ).json();
    assert.ok(analysis.analysis.details.ingredients.length >= 2);
    await request('/api/v1/private-products/' + snapshot.snapshotId, {
      cookie: sessions[1],
      status: 404,
    });
  }
  const list = await (
    await request('/api/v1/private-products', { cookie })
  ).json();
  assert.equal(list.snapshots.length, 2);
  const input = {
    schemaVersion: 1,
    slots: snapshots.map(({ snapshotId }) => ({ kind: 'PRIVATE', snapshotId })),
    brief: {
      mode: 'PERSONALIZED',
      goals: ['VOLUME'],
      waterproof: 'NO_PREFERENCE',
      removal: 'NO_PREFERENCE',
      avoidedIngredients: [],
      sensitiveEyes: true,
      contactLenses: false,
    },
  };
  const compared = await (
    await request('/api/v1/comparisons/private-preview', {
      cookie,
      method: 'POST',
      body: input,
    })
  ).json();
  assert.equal(compared.comparison.recommendation.kind, 'PREFERRED');
  assert.equal(compared.comparison.recommendation.slotIndex, 0);
  assert.equal(compared.comparison.recommendation.confidence, 'MEDIUM');
  assert.ok(compared.comparison.warnings.length >= 2);
  const partial = await (
    await request('/api/v1/comparisons/private-preview', {
      cookie,
      method: 'POST',
      body: {
        ...input,
        brief: { ...input.brief, avoidedIngredients: ['Beeswax'] },
      },
    })
  ).json();
  assert.equal(partial.comparison.recommendation.kind, 'NO_CLEAR_WINNER');
  assert.ok(
    partial.comparison.recommendation.reasonCodes.includes(
      'HARD_CONSTRAINT_DATA_MISSING',
    ),
  );
  await request('/api/v1/comparisons/private-preview', {
    cookie: sessions[1],
    method: 'POST',
    body: input,
    status: 404,
  });
  console.log(
    JSON.stringify({
      privateFlow: 'VERIFIED',
      ownedSnapshots: 2,
      idempotency: true,
      foreignAccessBlocked: true,
      incompleteFormulaBlocked: true,
    }),
  );
} finally {
  let cleanupFailed = false;
  for (const cookie of sessions) {
    let erased = false;
    for (let attempt = 0; attempt < 2 && !erased; attempt += 1) {
      try {
        await request('/api/v1/guest-sessions/current', {
          cookie,
          method: 'DELETE',
          status: 204,
        });
        await request('/api/v1/private-products', { cookie, status: 401 });
        erased = true;
      } catch {
        // Continue with every disposable owner, even if one cleanup fails.
      }
    }
    if (!erased) cleanupFailed = true;
  }
  console.log(
    JSON.stringify({
      disposableGuests: cleanupFailed ? 'CLEANUP_UNCONFIRMED' : 'DELETED',
    }),
  );
  assert.equal(cleanupFailed, false, 'Disposable guest cleanup unconfirmed');
}
