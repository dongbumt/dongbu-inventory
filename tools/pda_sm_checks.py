"""SM catalog and real receiving checks. Caller always rolls the transaction back."""
import uuid


def check_sm(conn, rpc, token, product, partner, commit, reject):
    def resolve(code, rule=None, fmt='auto', pid=product, trader=partner, source='동부엠티', reselect=False, mode='inbound', auth=token):
        return rpc('dbmt_pda_raw_resolve', auth, code, mode, pid, trader, rule, fmt, source, reselect)

    def key(mid, source='동부엠티'):
        return conn.execute("select rule_key from pda_private.raw_sm_formats where definition->>'source'=%s and definition->>'manuId'=%s", (source,str(mid))).fetchone()[0]

    def scan(item):
        return dict(barcode=item['code'],revision=item['revision'],rule=item['ruleKey'],labelWeight=item['weight'],checked=True)

    assert conn.execute('select count(*) from pda_private.raw_sm_formats').fetchone()[0] == 383
    assert conn.execute("select count(distinct (definition->'length',definition->'start',definition->'digits',definition->'decimals',definition->'factor',definition->'rounding')) from pda_private.raw_sm_formats").fetchone()[0] == 195
    shoulder='07607600224004601707009477'
    tenderloin='07607000109004601114007239'
    reject(lambda: resolve(shoulder,auth='bad'), '로그인')
    before=conn.execute('select count(*) from pda_private.raw_sm_links').fetchone()[0]
    options=resolve(shoulder)
    assert options['needsRule'] and 'item' not in options
    candidates={c['manuId']:c for c in options['candidates']}
    for mid,weight in [(56,2.09),(76,17.1),(130,17.07),(254,70.7),(297,.7),(305,94.77),(311,70.09),(315,4.6),(316,6.07)]:
        assert candidates[mid]['enabled'] and abs(candidates[mid]['smWeight']-weight)<.00001, (mid,candidates[mid])
    assert not candidates[266]['enabled'] and candidates[266]['reason'], 'Undefined start position must never be guessed'
    assert len(resolve(shoulder,source='전체')['candidates'])>len(options['candidates'])
    assert resolve(tenderloin)['needsRule'], 'Unfamiliar prefixes must use the full catalog, not a whitelist'
    new=resolve(shoulder,key(130))['item'];second=resolve(tenderloin,key(130))['item']
    assert new['weight']==17.07 and second['weight']==11.14 and second['barcodeLot'] is None
    old=conn.execute('select pda_private.raw_parse(%s,null)',(shoulder,)).fetchone()[0]
    assert old['weight']==17.07 and old['id']==new['id'] and old['ruleKey']!=new['ruleKey']
    assert resolve(']I0'+shoulder,key(130))['item']['id']==resolve(']Q3'+shoulder,key(130))['item']['id']
    assert resolve(shoulder,key(76))['item']['weight']==17.1, 'New catalog must honor SM rounding without rewriting legacy rules'
    assert conn.execute('select count(*) from pda_private.raw_sm_links').fetchone()[0]==before, 'Preview/selection must never save a profile or stock'
    for code in ['9826101312000000000001','270601682170500000212000247','DB2610131200-ABC120']:
        reject(lambda: resolve(code,key(130),fmt='sm'),'제품 바코드')
    reject(lambda: resolve('L12610261938001',fmt='sm'),'숫자형')
    reject(lambda: resolve('123456789012'),'원문')
    short=resolve('123456789012',fmt='sm')
    assert short['needsRule'] and any(c['enabled'] for c in short['candidates'])
    short_rule=next(c['key'] for c in short['candidates'] if c['enabled'])
    short_item=resolve('123456789012',short_rule,fmt='sm')['item']
    # A numeric nonstandard format may begin with a GS1-like prefix only in explicit SM mode.
    gs_like='01'+tenderloin[2:]
    reject(lambda: resolve(gs_like),'GTIN/SSCC')
    assert resolve(gs_like,key(130),fmt='sm')['item']['weight']==11.14
    with conn.transaction(force_rollback=True):
        req=uuid.uuid4()
        reject(lambda: commit('inbound',[scan(new)],lot=''),'이력번호')
        assert conn.execute('select count(*) from pda_private.raw_sm_links').fetchone()[0]==before
        invalid=scan(second);invalid['labelWeight']=999
        reject(lambda: commit('inbound',[scan(new),invalid]),'계산 중량')
        assert not resolve(shoulder,key(130))['item']['registered']
        assert conn.execute('select count(*) from pda_private.raw_sm_links').fetchone()[0]==before, 'Failed batches must roll back profile learning too'
        receipt=commit('inbound',[scan(new)],req=req,lot='L12610261938001')
        assert receipt['weight']==17.07
        assert commit('inbound',[scan(new)],req=req,lot='L12610261938001')['alreadySaved']
        next_code=shoulder[:-1]+'8'
        remembered=resolve(next_code)
        assert remembered['remembered'] and remembered['item']['ruleKey']==key(130)
        assert resolve(next_code,reselect=True)['needsRule']
        assert resolve(next_code,pid=product+'_other')['needsRule']
        assert resolve(next_code,trader=None)['needsRule']
        assert resolve(tenderloin)['needsRule'], 'A different prefix must not inherit the previous family'
        assert resolve(shoulder,key(76))['item']['ruleKey']==key(130), 'Stored package provenance always wins over current selection'
        reject(lambda: commit('inbound',[scan(resolve(shoulder)['item'])]),'중복 입고')
        shipped=commit('outbound',[scan(resolve(']I0'+shoulder,mode='outbound')['item'])],lot='')
        assert shipped['weight']==17.07 and shipped['items'][0]['lot']=='L12610261938001'
        # Legacy registered boxes must still use their original parser, even with a new format chosen.
        legacy=conn.execute('select pda_private.raw_parse(%s,null)',(tenderloin.replace('076070','076076',1),)).fetchone()[0]
        legacy=dict(legacy,revision=0)
        commit('inbound',[scan(legacy)],lot='LEGACY')
        assert resolve(legacy['code'],key(76))['item']['ruleKey']==legacy['ruleKey']
        commit('inbound',[scan(short_item)],lot='SHORT')
        assert resolve(short_item['code'],mode='outbound')['item']['registered']
        commit('outbound',[scan(resolve(short_item['code'],mode='outbound')['item'])],lot='')
        conn.execute('update pda_private.raw_sm_formats set active=false where rule_key=%s',(key(130),))
        assert resolve(next_code)['needsRule'], 'Inactive remembered formats must return to selection'
        assert resolve(shoulder,mode='outbound')['item']['registered'], 'Deactivating a format must not strand historical stock'
        reject(lambda: commit('inbound',[scan(second)]),'비활성')
    with conn.transaction():
        conn.execute('set local role anon')
        reject(lambda: conn.execute('select * from pda_private.raw_sm_formats'),'permission denied')
        reject(lambda: conn.execute('select * from pda_private.raw_sm_links'),'permission denied')
        reject(lambda: conn.execute("select pda_private.raw_sm_candidates(%s,'동부엠티')",(shoulder,)),'permission denied')
        conn.execute('set local role postgres')
    print('PASS: 383 original SM formats / 195 numeric conditions; screenshot weights/rounding/ranges, disabled invalid formats, explicit first choice, preview without writes, scoped receipt-only learning, atomic rollback/retry, duplicate aliases, legacy provenance, short SM codes and unchanged separate traceability')
