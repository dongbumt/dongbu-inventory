// =====================================================
// 동부엠티 ERP 시스템 — Code.gs
// =====================================================

const SCRIPT_PROPERTY_KEYS = {
  sheetId: 'SHEET_ID',
  mtraceUserId: 'MTRACE_USER_ID',
  mtraceApiKey: 'MTRACE_API_KEY',
  ekapeTraceServiceKey: 'EKAPE_TRACE_SERVICE_KEY',
  appToken: 'APP_TOKEN',
  appTokenSha256: 'APP_TOKEN_SHA256'
};
const DEFAULT_APP_TOKEN_SHA256 = 'e982589ecbd4d4445fe66f211a86ef19a9b0da59cce20381e77e351963febc63';

// Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성에서 설정한다.
// 필수: SHEET_ID
// 선택: APP_TOKEN 또는 APP_TOKEN_SHA256(없으면 기본 연동 비밀번호 해시 사용), MTRACE_USER_ID, MTRACE_API_KEY, EKAPE_TRACE_SERVICE_KEY
function getScriptProperty(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function getRequiredScriptProperty(key, label) {
  const value = getScriptProperty(key);
  if (!value) {
    throw new Error((label || key) + ' 스크립트 속성을 설정하세요.');
  }
  return value;
}

function openDbSpreadsheet() {
  return SpreadsheetApp.openById(
    getRequiredScriptProperty(SCRIPT_PROPERTY_KEYS.sheetId, 'SHEET_ID')
  );
}

function getTraceServiceKey() {
  return getScriptProperty(SCRIPT_PROPERTY_KEYS.ekapeTraceServiceKey) ||
         getScriptProperty(SCRIPT_PROPERTY_KEYS.mtraceApiKey);
}

function getMtraceCredentials() {
  return {
    userId: getScriptProperty(SCRIPT_PROPERTY_KEYS.mtraceUserId),
    apiKey: getScriptProperty(SCRIPT_PROPERTY_KEYS.mtraceApiKey)
  };
}

function requireAppToken(token) {
  token = String(token || '');
  const required = getScriptProperty(SCRIPT_PROPERTY_KEYS.appToken);
  const requiredHash = getScriptProperty(SCRIPT_PROPERTY_KEYS.appTokenSha256) || DEFAULT_APP_TOKEN_SHA256;
  if (!required && !requiredHash) {
    throw new Error('연동 비밀번호가 설정되지 않았습니다.');
  }
  if (required && token !== required) {
    throw new Error('연동 비밀번호가 일치하지 않습니다.');
  }
  if (!required && sha256Hex(token) !== requiredHash) {
    throw new Error('연동 비밀번호가 일치하지 않습니다.');
  }
}

function setAppTokenForSetup(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('token is required');
  PropertiesService.getScriptProperties().setProperty(SCRIPT_PROPERTY_KEYS.appToken, token);
  return {ok:true, tokenLength:token.length};
}

function sha256Hex(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ''),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    const v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

const TX_HEADERS = [
  'id','date','type','product','origin','packunit','trader','storage','lot','proddate',
  'weight','price','amount','note','_isUser','_isProdUse','_isProdOut','_prodId',
  '_isStockAdjust','stockBefore','stockActual','updatedAt','deletedAt'
];
const PRICE_HEADERS = ['id','product','origin','trader','price','updatedAt','deletedAt'];
const PROD_HEADERS = ['json','id','updatedAt','deletedAt'];
const CHANGE_LOG_HEADERS = ['at','entity','action','id','summary','payload'];

// ── 도메인 시트 레지스트리 ──
// 각 키는 index.html의 APP_DATA_REGISTRY와 일치해야 한다.
// 시트가 존재하면 거기서 읽고, 없으면 앱데이터 시트에서 fallback.
//
// 옵션:
//   name     : Google Sheets 시트명
//   headers  : 컬럼 헤더 배열
//   toRows   : (도메인값) → 시트 저장용 배열 변환. 생략 시 그대로 사용 (배열 도메인)
//   fromRows : (시트의 행 배열) → 도메인 원래 형태로 복원. 생략 시 그대로 사용
const DOMAIN_SHEETS = {
  scheduleEvents: {
    name: '일정',
    headers: ['id','date','text']
  },
  docChecks: {
    name: '서류체크',
    headers: ['key','checked'],
    toRows: function(obj) {
      return Object.entries(obj || {}).map(function(pair) {
        return { key: pair[0], checked: !!pair[1] };
      });
    },
    fromRows: function(rows) {
      var result = {};
      rows.forEach(function(r) {
        if (r.key) result[r.key] = (r.checked === true || r.checked === 'TRUE' || r.checked === 'true' || r.checked === 1);
      });
      return result;
    }
  },
  factorySimScenarios: {
    name: '공장시뮬레이션',
    headers: ['id','name','width','depth','workers','shiftHours','targetKg','baseWorkers','baseDailyKg','note','updatedAt','zones','equipment','routes'],
    toRows: function(arr) {
      return (arr || []).map(function(s) {
        return {
          id:          String(s.id == null ? '' : s.id),
          name:        s.name || '',
          width:       s.width == null ? '' : s.width,
          depth:       s.depth == null ? '' : s.depth,
          workers:     s.workers == null ? '' : s.workers,
          shiftHours:  s.shiftHours == null ? '' : s.shiftHours,
          targetKg:    s.targetKg == null ? '' : s.targetKg,
          baseWorkers: s.baseWorkers == null ? '' : s.baseWorkers,
          baseDailyKg: s.baseDailyKg == null ? '' : s.baseDailyKg,
          note:        s.note || '',
          updatedAt:   s.updatedAt || '',
          zones:       JSON.stringify(s.zones || []),
          equipment:   JSON.stringify(s.equipment || []),
          routes:      JSON.stringify(s.routes || [])
        };
      });
    },
    fromRows: function(rows) {
      var parseJson = function(v) {
        if (v == null || v === '') return [];
        try { return JSON.parse(String(v)); } catch(e) { return []; }
      };
      return rows.map(function(r) {
        return {
          id:          String(r.id == null ? '' : r.id),
          name:        r.name || '',
          width:       r.width === '' || r.width == null ? '' : r.width,
          depth:       r.depth === '' || r.depth == null ? '' : r.depth,
          workers:     r.workers === '' || r.workers == null ? '' : r.workers,
          shiftHours:  r.shiftHours === '' || r.shiftHours == null ? '' : r.shiftHours,
          targetKg:    r.targetKg === '' || r.targetKg == null ? '' : r.targetKg,
          baseWorkers: r.baseWorkers === '' || r.baseWorkers == null ? '' : r.baseWorkers,
          baseDailyKg: r.baseDailyKg === '' || r.baseDailyKg == null ? '' : r.baseDailyKg,
          note:        r.note || '',
          updatedAt:   r.updatedAt || '',
          zones:       parseJson(r.zones),
          equipment:   parseJson(r.equipment),
          routes:      parseJson(r.routes)
        };
      });
    }
  },
  labelTemplates: {
    name: '라벨템플릿',
    // weight 컬럼은 getRows의 parseFloat 자동변환을 피하려고 labelweight로 저장
    headers: ['id','name','size','product','origin','grade','slaughter','carcass','labelweight','itemno','ingredients','licenseno','prodtype','packaging','storage','manufacturer','phone','address'],
    toRows: function(arr) {
      return (arr || []).map(function(t) {
        return {
          id:           t.id,
          name:         t.name || '',
          size:         t.size || '',
          product:      t.product || '',
          origin:       t.origin || '',
          grade:        t.grade || '',
          slaughter:    t.slaughter || '',
          carcass:      t.carcass || '',
          labelweight:  t.weight == null ? '' : String(t.weight),
          itemno:       t.itemno || '',
          ingredients:  t.ingredients || '',
          licenseno:    t.licenseno || '',
          prodtype:     t.prodtype || '',
          packaging:    t.packaging || '',
          storage:      t.storage || '',
          manufacturer: t.manufacturer || '',
          phone:        t.phone || '',
          address:      t.address || ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        var idNum = Number(r.id);
        return {
          id:           isNaN(idNum) ? r.id : idNum,
          name:         r.name || '',
          size:         r.size || '',
          product:      r.product || '',
          origin:       r.origin || '',
          grade:        r.grade || '',
          slaughter:    r.slaughter || '',
          carcass:      r.carcass || '',
          weight:       r.labelweight == null ? '' : String(r.labelweight),
          itemno:       r.itemno || '',
          ingredients:  r.ingredients || '',
          licenseno:    r.licenseno || '',
          prodtype:     r.prodtype || '',
          packaging:    r.packaging || '',
          storage:      r.storage || '',
          manufacturer: r.manufacturer || '',
          phone:        r.phone || '',
          address:      r.address || ''
        };
      });
    }
  },
  labelProducts: {
    name: '라벨품목',
    headers: ['id','name','origin','kind','meattype','storage','shelfdays','packunit','itemno','grade'],
    toRows: function(arr) {
      return (arr || []).map(function(p) {
        return {
          id:        String(p.id == null ? '' : p.id),
          name:      p.name || '',
          origin:    p.origin || '',
          kind:      p.kind || '',
          meattype:  p.meattype || '',
          storage:   p.storage || '',
          shelfdays: p.shelfdays || 0,
          packunit:  p.packunit || '',
          itemno:    p.itemno || '',
          grade:     p.grade || ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        return {
          id:        String(r.id == null ? '' : r.id),
          name:      r.name || '',
          origin:    r.origin || '',
          kind:      r.kind || '',
          meattype:  r.meattype || '',
          storage:   r.storage || '',
          shelfdays: parseInt(r.shelfdays) || 0,
          packunit:  r.packunit || '',
          itemno:    r.itemno || '',
          grade:     r.grade || ''
        };
      });
    }
  },
  traderInfoMap: {
    name: '거래처',
    headers: ['name','fullname','regno','ceo','addr','biz'],
    toRows: function(obj) {
      return Object.entries(obj || {}).map(function(pair) {
        var info = pair[1] || {};
        return {
          name:     pair[0],
          fullname: info.fullname || '',
          regno:    String(info.regno || ''),
          ceo:      info.ceo || '',
          addr:     info.addr || '',
          biz:      info.biz || ''
        };
      });
    },
    fromRows: function(rows) {
      var result = {};
      rows.forEach(function(r) {
        if (r.name) {
          result[String(r.name)] = {
            fullname: String(r.fullname || ''),
            regno:    String(r.regno || ''),
            ceo:      String(r.ceo || ''),
            addr:     String(r.addr || ''),
            biz:      String(r.biz || '')
          };
        }
      });
      return result;
    }
  },
  employees: {
    name: '직원',
    headers: ['id','name','position','hireDate','phone','addr','birthDate','birthCal','healthExpiry','monthlySalary','resignDate','settlement','pastSettlements'],
    toRows: function(arr) {
      return (arr || []).map(function(e) {
        return {
          id:            String(e.id == null ? '' : e.id),
          name:          e.name || '',
          position:      e.position || '',
          hireDate:      e.hireDate || '',
          phone:         e.phone || '',
          addr:          e.addr || '',
          birthDate:     e.birthDate || '',
          birthCal:      e.birthCal || '',
          healthExpiry:  e.healthExpiry || '',
          monthlySalary: e.monthlySalary || 0,
          resignDate:    e.resignDate || '',
          settlement:    e.settlement ? JSON.stringify(e.settlement) : '',
          pastSettlements: (e.pastSettlements && e.pastSettlements.length) ? JSON.stringify(e.pastSettlements) : ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        var emp = {
          id:            String(r.id == null ? '' : r.id),
          name:          r.name || '',
          position:      r.position || '',
          hireDate:      r.hireDate || '',
          phone:         r.phone || '',
          addr:          r.addr || '',
          birthDate:     r.birthDate || '',
          birthCal:      r.birthCal || '',
          healthExpiry:  r.healthExpiry || '',
          monthlySalary: parseFloat(r.monthlySalary) || 0,
          resignDate:    r.resignDate || '',
          settlement:    null,
          pastSettlements: []
        };
        if (r.settlement) {
          try { emp.settlement = JSON.parse(String(r.settlement)); } catch(e) {}
        }
        if (r.pastSettlements) {
          try { emp.pastSettlements = JSON.parse(String(r.pastSettlements)); } catch(e) {}
        }
        return emp;
      });
    }
  },
  subMaterialItems: {
    name: '부자재품목',
    headers: ['id','code','name','spec','unit','unitPrice','note'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:        String(x.id == null ? '' : x.id),
          code:      x.code || '',
          name:      x.name || '',
          spec:      x.spec || '',
          unit:      x.unit || '',
          unitPrice: (x.unitPrice == null || x.unitPrice === '') ? '' : x.unitPrice,
          note:      x.note || ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        return {
          id:        String(r.id == null ? '' : r.id),
          code:      String(r.code || ''),
          name:      String(r.name || ''),
          spec:      String(r.spec || ''),
          unit:      String(r.unit || ''),
          unitPrice: (r.unitPrice === '' || r.unitPrice == null) ? '' : (Number(r.unitPrice) || 0),
          note:      String(r.note || '')
        };
      });
    }
  },
  subMaterialLots: {
    name: '부자재입고',
    headers: ['id','date','lot','itemId','itemCode','itemName','itemSpec','trader','qty','unit','certName','note','createdAt'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:        String(x.id == null ? '' : x.id),
          date:      x.date || '',
          lot:       x.lot || '',
          itemId:    String(x.itemId == null ? '' : x.itemId),
          itemCode:  x.itemCode || '',
          itemName:  x.itemName || '',
          itemSpec:  x.itemSpec || '',
          trader:    x.trader || '',
          qty:       (x.qty == null || x.qty === '') ? '' : x.qty,
          unit:      x.unit || '',
          certName:  x.certName || '',
          note:      x.note || '',
          createdAt: x.createdAt ? "'" + x.createdAt : ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        return {
          id:        String(r.id == null ? '' : r.id),
          date:      String(r.date || ''),
          lot:       String(r.lot || ''),
          itemId:    String(r.itemId == null ? '' : r.itemId),
          itemCode:  String(r.itemCode || ''),
          itemName:  String(r.itemName || ''),
          itemSpec:  String(r.itemSpec || ''),
          trader:    String(r.trader || ''),
          qty:       (r.qty === '' || r.qty == null) ? 0 : (Number(r.qty) || 0),
          unit:      String(r.unit || ''),
          certName:  String(r.certName || ''),
          note:      String(r.note || ''),
          createdAt: String(r.createdAt || '')
        };
      });
    }
  },
  subMaterialCounts: {
    name: '부자재조사',
    headers: ['id','date','itemId','itemCode','itemName','itemSpec','qty','unit','manager','note','createdAt'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:        String(x.id == null ? '' : x.id),
          date:      x.date || '',
          itemId:    String(x.itemId == null ? '' : x.itemId),
          itemCode:  x.itemCode || '',
          itemName:  x.itemName || '',
          itemSpec:  x.itemSpec || '',
          qty:       (x.qty == null || x.qty === '') ? '' : x.qty,
          unit:      x.unit || '',
          manager:   x.manager || '',
          note:      x.note || '',
          createdAt: x.createdAt ? "'" + x.createdAt : ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        return {
          id:        String(r.id == null ? '' : r.id),
          date:      String(r.date || ''),
          itemId:    String(r.itemId == null ? '' : r.itemId),
          itemCode:  String(r.itemCode || ''),
          itemName:  String(r.itemName || ''),
          itemSpec:  String(r.itemSpec || ''),
          qty:       (r.qty === '' || r.qty == null) ? 0 : (Number(r.qty) || 0),
          unit:      String(r.unit || ''),
          manager:   String(r.manager || ''),
          note:      String(r.note || ''),
          createdAt: String(r.createdAt || '')
        };
      });
    }
  },
  leaveRecs: {
    name: '연차',
    headers: ['id','empId','date','type','days','reason'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:     String(x.id == null ? '' : x.id),
          empId:  String(x.empId == null ? '' : x.empId),
          date:   x.date || '',
          type:   x.type || '',
          days:   (x.days == null || x.days === '') ? '' : x.days,
          reason: x.reason || ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        return {
          id:     String(r.id == null ? '' : r.id),
          empId:  String(r.empId == null ? '' : r.empId),
          date:   String(r.date || ''),
          type:   String(r.type || ''),
          days:   (r.days === '' || r.days == null) ? 0 : (Number(r.days) || 0),
          reason: String(r.reason || '')
        };
      });
    }
  },
  pgbList: {
    name: '판관비',
    headers: ['id','name','monthlyCost','active'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:          x.id,
          name:        x.name || '',
          monthlyCost: (x.monthlyCost == null || x.monthlyCost === '') ? 0 : x.monthlyCost,
          active:      !!x.active
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        var idNum = Number(r.id);
        return {
          id:          isNaN(idNum) ? r.id : idNum,
          name:        String(r.name || ''),
          monthlyCost: Number(r.monthlyCost) || 0,
          active:      (r.active === true || r.active === 'TRUE' || r.active === 'true' || r.active === 1)
        };
      });
    }
  },
  costCalcHistory: {
    name: '원가이력',
    headers: ['id','date','names','totInput','totOutput','totRawCost','totExpCost','totalCost','costPerKg','sellPrice','revenue','profit','dailyQty','workers','materials'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:         x.id,
          date:       x.date || '',
          names:      x.names || '',
          totInput:   x.totInput || 0,
          totOutput:  x.totOutput || 0,
          totRawCost: x.totRawCost || 0,
          totExpCost: x.totExpCost || 0,
          totalCost:  x.totalCost || 0,
          costPerKg:  x.costPerKg || 0,
          sellPrice:  x.sellPrice || 0,
          revenue:    x.revenue || 0,
          profit:     x.profit || 0,
          dailyQty:   x.dailyQty || 0,
          workers:    x.workers || 0,
          materials:  x.materials || ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        var idNum = Number(r.id);
        return {
          id:         isNaN(idNum) ? r.id : idNum,
          date:       String(r.date || ''),
          names:      String(r.names || ''),
          totInput:   Number(r.totInput) || 0,
          totOutput:  Number(r.totOutput) || 0,
          totRawCost: Number(r.totRawCost) || 0,
          totExpCost: Number(r.totExpCost) || 0,
          totalCost:  Number(r.totalCost) || 0,
          costPerKg:  Number(r.costPerKg) || 0,
          sellPrice:  Number(r.sellPrice) || 0,
          revenue:    Number(r.revenue) || 0,
          profit:     Number(r.profit) || 0,
          dailyQty:   Number(r.dailyQty) || 0,
          workers:    Number(r.workers) || 0,
          materials:  String(r.materials || '')
        };
      });
    }
  },
  expenseList: {
    name: '지출',
    headers: ['id','date','paytype','storetype','store','category','item','amount','note'],
    toRows: function(arr) {
      return (arr || []).map(function(x) {
        return {
          id:        x.id,
          date:      x.date || '',
          paytype:   x.paytype || '',
          storetype: x.storetype || '',
          store:     x.store || '',
          category:  x.category || '',
          item:      x.item || '',
          amount:    (x.amount == null || x.amount === '') ? 0 : x.amount,
          note:      x.note || ''
        };
      });
    },
    fromRows: function(rows) {
      return rows.map(function(r) {
        var idNum = Number(r.id);
        return {
          id:        isNaN(idNum) ? r.id : idNum,
          date:      String(r.date || ''),
          paytype:   String(r.paytype || ''),
          storetype: String(r.storetype || ''),
          store:     String(r.store || ''),
          category:  String(r.category || ''),
          item:      String(r.item || ''),
          amount:    Number(r.amount) || 0,
          note:      String(r.note || '')
        };
      });
    }
  },
  // 다음 도메인은 점진적으로 추가
};

// GET: JSONP 방식 (CORS 우회) + 일반 JSON 겸용
function doGet(e) {
  try {
    const action = e.parameter.action || '';

    let result;
    if (action === 'getAll') {
      requireAppToken(e.parameter.token);
      result = {ok:true, data:getAll()};
    } else if (action === 'ping') {
      result = {ok:true, data:{
        pong:true,
        tokenRequired: !!getScriptProperty(SCRIPT_PROPERTY_KEYS.appToken),
        time:new Date().toISOString()
      }};
    } else if (action === 'getTraceInfo') {
      requireAppToken(e.parameter.token);
      result = {ok:true, data: getTraceInfo(e.parameter.traceNo || '', e.parameter.baseDate || '')};
    } else {
      result = {ok:false, error:'unknown action'};
    }

    return jsonGetRes(result, e.parameter.callback);

  } catch(err) {
    return jsonGetRes({ok:false, error:err.message}, e.parameter.callback);
  }
}

function jsonGetRes(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(String(callback).replace(/[^\w.$]/g, '') + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// POST: 데이터 저장
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    requireAppToken(body.token);
    if (body.action === 'saveAll') {
      return jsonRes({ok:false, error:'saveAll은 데이터 보호를 위해 비활성화되었습니다. saveCorePatch를 사용하세요.'});
    }
    if (body.action === 'saveCorePatch') {
      const result = withScriptLock(function() { return saveCorePatch(body.data); });
      return jsonRes({ok:true, data:result});
    }
    if (body.action === 'saveAppData') {
      withScriptLock(function() { saveAppData(body.data); });
      return jsonRes({ok:true});
    }
    return jsonRes({ok:false, error:'unknown action'});
  } catch(err) {
    return jsonRes({ok:false, error:err.message});
  }
}

function jsonRes(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── 전체 읽기 ──────────────────────────────────────────
function getAll() {
  const ss = openDbSpreadsheet();
  return {
    transactions: getRows('거래내역', TX_HEADERS, ss).filter(isActiveRow),
    prod:     getProd(ss),
    prices:   getPrices(ss),
    appData:  getAppData(ss),
  };
}

// ── 전체 저장 비활성화 ──────────────────────────────────
function saveAll(d) {
  throw new Error('saveAll은 데이터 보호를 위해 비활성화되었습니다. saveCorePatch를 사용하세요.');
}

// ── 행 단위 저장 (거래내역·생산일보·단가) ──────────────────
function saveCorePatch(patch) {
  patch = patch || {};
  const ss = openDbSpreadsheet();
  const result = {};
  if (patch.transactions) {
    result.transactions = applyRowsPatch('거래내역', TX_HEADERS, patch.transactions, 'transaction', ss);
  }
  if (patch.prod) {
    result.prod = applyProdPatch(patch.prod, ss);
  }
  if (patch.prices) {
    result.prices = applyRowsPatch('단가표', PRICE_HEADERS, normalizePricePatch(patch.prices), 'price', ss);
  }
  result.counts = {
    transactions: getRows('거래내역', TX_HEADERS, ss).filter(isActiveRow).length,
    prod: getProd(ss).length,
    prices: getPrices(ss).length
  };
  return result;
}

function normalizePricePatch(patch) {
  patch = patch || {};
  const upsert = (patch.upsert || []).map(function(p) {
    const row = Object.assign({}, p || {});
    row.id = row.id || buildPriceId(row);
    return row;
  });
  const del = (patch.delete || []).map(function(p) {
    if (typeof p === 'object') return p.id || buildPriceId(p);
    return p;
  });
  return {upsert: upsert, delete: del};
}

function buildPriceId(p) {
  return [
    'price',
    normalizeKey(p && p.product),
    normalizeKey(p && p.origin),
    normalizeKey(p && p.trader)
  ].join('|');
}

function normalizeKey(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
}

function entityId(v) {
  return String(v == null ? '' : v).trim();
}

function isActiveRow(row) {
  return !String(row && (row.deletedAt || row._deletedAt) || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function summarizeRow(row) {
  row = row || {};
  return [
    row.date || row.product || row.id || '',
    row.type || row.origin || '',
    row.lot || row.trader || ''
  ].filter(Boolean).join(' / ').slice(0, 200);
}

function appendChangeLog(ss, entity, action, id, row) {
  const sh = getOrCreate('변경로그', ss);
  ensureSheetHeaders(sh, CHANGE_LOG_HEADERS);
  sh.appendRow([
    nowIso(),
    entity,
    action,
    entityId(id),
    summarizeRow(row),
    JSON.stringify(row || {})
  ]);
}

function applyRowsPatch(sheetName, headers, patch, entity, ss) {
  patch = patch || {};
  const sh = getOrCreate(sheetName, ss);
  const h = ensureSheetHeaders(sh, headers);
  const values = sh.getDataRange().getValues();
  const idCol = h.indexOf('id');
  const deletedCol = h.indexOf('deletedAt');
  const updatedCol = h.indexOf('updatedAt');
  const rowById = {};
  for (let r = 1; r < values.length; r++) {
    let id = entityId(values[r][idCol]);
    if (!id && entity === 'price') {
      const obj = {};
      h.forEach(function(k, i) { obj[k] = values[r][i]; });
      id = buildPriceId(obj);
      if (id && idCol >= 0) sh.getRange(r + 1, idCol + 1).setValue(id);
    }
    if (id) rowById[id] = r + 1;
  }

  let upserted = 0;
  (patch.upsert || []).forEach(function(item) {
    const row = Object.assign({}, item || {});
    const id = entityId(row.id);
    if (!id) return;
    if (entity !== 'transaction') row.id = id;
    row.deletedAt = '';
    row.updatedAt = nowIso();
    const rowValues = h.map(function(k) { return row[k] !== undefined ? row[k] : ''; });
    const rowNo = rowById[id];
    if (rowNo) {
      sh.getRange(rowNo, 1, 1, h.length).setValues([rowValues]);
      appendChangeLog(ss, entity, 'update', id, row);
    } else {
      sh.appendRow(rowValues);
      rowById[id] = sh.getLastRow();
      appendChangeLog(ss, entity, 'create', id, row);
    }
    upserted++;
  });

  let deleted = 0;
  (patch.delete || []).forEach(function(rawId) {
    const id = entityId(rawId);
    if (!id) return;
    const rowNo = rowById[id];
    const tombstone = {id: id, deletedAt: nowIso(), updatedAt: nowIso()};
    if (rowNo) {
      if (deletedCol >= 0) sh.getRange(rowNo, deletedCol + 1).setValue(tombstone.deletedAt);
      if (updatedCol >= 0) sh.getRange(rowNo, updatedCol + 1).setValue(tombstone.updatedAt);
    } else {
      const rowValues = h.map(function(k) { return tombstone[k] !== undefined ? tombstone[k] : ''; });
      sh.appendRow(rowValues);
    }
    appendChangeLog(ss, entity, 'delete', id, tombstone);
    deleted++;
  });

  return {upserted: upserted, deleted: deleted};
}

function applyProdPatch(patch, ss) {
  patch = patch || {};
  const sh = getOrCreate('생산일보', ss);
  const h = ensureSheetHeaders(sh, PROD_HEADERS);
  const values = sh.getDataRange().getValues();
  const jsonCol = Math.max(0, h.indexOf('json'));
  const idCol = h.indexOf('id');
  const updatedCol = h.indexOf('updatedAt');
  const deletedCol = h.indexOf('deletedAt');
  const rowById = {};
  for (let r = 1; r < values.length; r++) {
    let obj = {};
    try { obj = JSON.parse(String(values[r][jsonCol] || '{}')); } catch(e) {}
    const id = entityId(values[r][idCol] || obj.id);
    if (id) rowById[id] = {rowNo: r + 1, obj: obj};
  }

  let upserted = 0;
  (patch.upsert || []).forEach(function(item) {
    const row = Object.assign({}, item || {});
    const id = entityId(row.id);
    if (!id) return;
    row.id = id;
    row._deletedAt = '';
    row.updatedAt = nowIso();
    const rowValues = h.map(function(k) {
      if (k === 'json') return JSON.stringify(row);
      if (k === 'id') return id;
      if (k === 'updatedAt') return row.updatedAt;
      if (k === 'deletedAt') return '';
      return row[k] !== undefined ? row[k] : '';
    });
    const current = rowById[id];
    if (current) {
      sh.getRange(current.rowNo, 1, 1, h.length).setValues([rowValues]);
      appendChangeLog(ss, 'prod', 'update', id, row);
    } else {
      sh.appendRow(rowValues);
      rowById[id] = {rowNo: sh.getLastRow(), obj: row};
      appendChangeLog(ss, 'prod', 'create', id, row);
    }
    upserted++;
  });

  let deleted = 0;
  (patch.delete || []).forEach(function(rawId) {
    const id = entityId(rawId);
    if (!id) return;
    const current = rowById[id];
    const row = Object.assign({}, current ? current.obj : {id: id});
    row.id = id;
    row._deletedAt = nowIso();
    row.updatedAt = row._deletedAt;
    const rowValues = h.map(function(k) {
      if (k === 'json') return JSON.stringify(row);
      if (k === 'id') return id;
      if (k === 'updatedAt') return row.updatedAt;
      if (k === 'deletedAt') return row._deletedAt;
      return row[k] !== undefined ? row[k] : '';
    });
    if (current) sh.getRange(current.rowNo, 1, 1, h.length).setValues([rowValues]);
    else sh.appendRow(rowValues);
    appendChangeLog(ss, 'prod', 'delete', id, row);
    deleted++;
  });

  return {upserted: upserted, deleted: deleted};
}

// ── 보조 데이터 읽기 ──────────────────────────────────
// 도메인 시트가 있으면 우선 사용, 없으면 앱데이터 시트에서 JSON 파싱
function getAppData(ss) {
  ss = ss || openDbSpreadsheet();
  const sh   = getOrCreate('앱데이터', ss);
  const rows = sh.getDataRange().getValues();
  const result = {};
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][0] || '').trim();
    const val = String(rows[i][1] || '').trim();
    if (!key || !val) continue;
    try { result[key] = JSON.parse(val); } catch(e) { result[key] = val; }
  }

  // 도메인 시트가 존재하면 덮어쓰기 (마이그레이션 완료된 도메인)
  Object.keys(DOMAIN_SHEETS).forEach(domain => {
    const config = DOMAIN_SHEETS[domain];
    const domainSheet = ss.getSheetByName(config.name);
    if (domainSheet && domainSheet.getLastRow() > 0) {
      const rows = getRows(config.name, config.headers, ss);
      result[domain] = config.fromRows ? config.fromRows(rows) : rows;
    }
  });

  return result;
}

// ── 보조 데이터 저장 ──────────────────────────────────
// 도메인 시트가 정의된 항목은 그쪽에 저장, 나머지는 앱데이터 시트에 JSON으로
function saveAppData(d) {
  if (!d) return;
  const ss = openDbSpreadsheet();

  // 1) 도메인 시트에 저장 (이미 마이그레이션된 항목)
  const domainHandled = new Set();
  Object.keys(DOMAIN_SHEETS).forEach(domain => {
    if (d[domain] !== undefined) {
      const config = DOMAIN_SHEETS[domain];
      const arr = config.toRows ? config.toRows(d[domain]) : d[domain];
      saveRows(config.name, arr, config.headers, ss);
      domainHandled.add(domain);
    }
  });

  // 2) 나머지는 앱데이터 시트에 JSON으로 저장 (기존 방식)
  const sh = getOrCreate('앱데이터', ss);
  const existing = {};
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][0] || '').trim();
    const val = String(rows[i][1] || '').trim();
    // 도메인 시트로 옮겨진 키는 앱데이터에서 제외
    if (key && val && !domainHandled.has(key)) existing[key] = val;
  }
  Object.keys(d).forEach(k => {
    if (d[k] !== undefined && !domainHandled.has(k)) {
      existing[k] = JSON.stringify(d[k]);
    }
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
  const entries = Object.entries(existing);
  if (entries.length > 0) {
    sh.getRange(2, 1, entries.length, 2).setValues(entries);
  }
}

// ── 마이그레이션 함수 (Apps Script 편집기에서 1회 실행) ──
// 앱데이터 시트의 JSON 키를 DOMAIN_SHEETS에 정의된 도메인 시트로 이주.
// 이주 후 앱데이터 시트에서 해당 키 제거 (앱데이터 시트는 보존, 백업 권장).
function migrateAppDataToSheets() {
  const ss = openDbSpreadsheet();
  const appSheet = getOrCreate('앱데이터', ss);
  const rows = appSheet.getDataRange().getValues();
  const appData = {};
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][0] || '').trim();
    const val = String(rows[i][1] || '').trim();
    if (!key || !val) continue;
    try { appData[key] = JSON.parse(val); } catch(e) {}
  }

  const migrated = [];
  const removedKeys = new Set();
  Object.keys(DOMAIN_SHEETS).forEach(domain => {
    if (appData[domain] === undefined) return;
    const config = DOMAIN_SHEETS[domain];
    const arr = config.toRows ? config.toRows(appData[domain]) : appData[domain];
    if (!Array.isArray(arr)) return; // toRows가 없는데 객체면 스킵
    saveRows(config.name, arr, config.headers, ss);
    migrated.push(domain + ' → 시트["' + config.name + '"] (' + arr.length + '건)');
    removedKeys.add(domain);
  });

  // 앱데이터에서 이주된 키 제거
  if (removedKeys.size > 0) {
    const newRows = [['key', 'value']];
    for (let i = 1; i < rows.length; i++) {
      const key = String(rows[i][0] || '').trim();
      if (key && !removedKeys.has(key)) {
        newRows.push([rows[i][0], rows[i][1]]);
      }
    }
    appSheet.clearContents();
    appSheet.getRange(1, 1, newRows.length, 2).setValues(newRows);
  }

  const msg = migrated.length > 0
    ? '마이그레이션 완료:\n' + migrated.join('\n')
    : '이주할 데이터 없음 (DOMAIN_SHEETS에 정의된 키 중 앱데이터에 없음)';
  Logger.log(msg);
  return msg;
}

// ── 행 읽기 ───────────────────────────────────────────
function ensureSheetHeaders(sh, headers) {
  headers = headers || [];
  const minCols = Math.max(1, headers.length);
  const lastCol = Math.max(sh.getLastColumn(), minCols);
  let existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(v) {
    return String(v || '').trim();
  });
  const hasHeader = existing.some(function(v) { return v; });
  if (!hasHeader) {
    if (headers.length) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return headers.slice();
  }
  let changed = false;
  headers.forEach(function(h) {
    if (existing.indexOf(h) < 0) {
      existing.push(h);
      changed = true;
    }
  });
  existing = existing.filter(function(v, idx) {
    return v || idx < headers.length;
  });
  if (changed) sh.getRange(1, 1, 1, existing.length).setValues([existing]);
  return existing;
}

function getRows(sheetName, headers, ss) {
  const sh   = getOrCreate(sheetName, ss);
  const h = ensureSheetHeaders(sh, headers);
  const rows = sh.getDataRange().getValues();
  if (rows.length <= 1) return [];
  return rows.slice(1).map(row => {
    const obj = {};
    h.forEach((k, i) => {
      let v = row[i];
      // Date 객체는 어느 컬럼이든 yyyy-MM-dd로 통일
      if (v instanceof Date) {
        v = Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
      }
      if (['weight','price','amount','stockBefore','stockActual'].includes(k)) {
        v = parseFloat(v) || 0;
      } else if (k === 'id') {
        // id는 자동 변환 안 함 (도메인별 자연 타입 유지)
        // - 거래내역: Date.now() → number 셀로 저장 → number로 복원
        // - 직원/연차: hrId() → string 셀로 저장 → string으로 복원
      } else if (['date','proddate'].includes(k)) {
        if (v instanceof Date) {
          v = Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
        } else {
          v = String(v || '');
          if (v.length > 10 && v.includes(' ')) {
            try {
              const d = new Date(v);
              if (!isNaN(d)) v = Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
            } catch(e) {}
          }
        }
      } else if (['lot','product','origin','packunit','trader','storage','type','note','updatedAt','deletedAt'].includes(k)) {
        v = String(v || '');
      } else if (['_isUser','_isProdUse','_isProdOut','_isStockAdjust'].includes(k)) {
        v = (v === true || v === 'TRUE' || v === 'true');
      }
      obj[k] = v;
    });
    return obj;
  });
}

// ── 행 저장 ───────────────────────────────────────────
function saveRows(sheetName, arr, headers, ss) {
  const sh = getOrCreate(sheetName, ss);
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!arr || !arr.length) return;
  const rows = arr.map(t => headers.map(k => t[k] !== undefined ? t[k] : ''));
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function getPrices(ss) {
  return getRows('단가표', PRICE_HEADERS, ss)
    .filter(isActiveRow)
    .map(function(p) {
      if (!p.id) p.id = buildPriceId(p);
      return p;
    });
}

// ── 생산일보 읽기 ──────────────────────────────────────
function getProd(ss) {
  const sh   = getOrCreate('생산일보', ss);
  const headers = ensureSheetHeaders(sh, PROD_HEADERS);
  const jsonCol = Math.max(0, headers.indexOf('json'));
  const deletedCol = headers.indexOf('deletedAt');
  const rows = sh.getDataRange().getValues();
  if (rows.length <= 1) return [];
  return rows.slice(1)
    .map(r => {
      try {
        const obj = JSON.parse(r[jsonCol]);
        if (deletedCol >= 0 && String(r[deletedCol] || '').trim()) obj._deletedAt = String(r[deletedCol] || '').trim();
        return obj;
      } catch(e) {
        return null;
      }
    })
    .filter(function(row) { return row && isActiveRow(row); });
}

// ── 생산일보 저장 ──────────────────────────────────────
function saveProd(arr, ss) {
  const sh = getOrCreate('생산일보', ss);
  sh.clearContents();
  sh.getRange(1, 1, 1, PROD_HEADERS.length).setValues([PROD_HEADERS]);
  if (!arr || !arr.length) return;
  sh.getRange(2, 1, arr.length, PROD_HEADERS.length).setValues(arr.map(function(e) {
    return [JSON.stringify(e), e.id || '', e.updatedAt || '', e._deletedAt || e.deletedAt || ''];
  }));
}

// =====================================================
// 축산물이력제 OpenAPI (ekape.or.kr)
// =====================================================
// data.go.kr traceNoSearch는 EKAPE_TRACE_SERVICE_KEY를 우선 사용한다.
// 별도 키가 없으면 MTRACE_API_KEY를 fallback으로 사용한다.
var EKAPE_URLS = [
  'https://data.ekape.or.kr/openapi-data/service/user/animalTrace/traceNoSearch',
  'http://data.ekape.or.kr/openapi-data/service/user/animalTrace/traceNoSearch'
];
var MEATWATCH_DISTB_URL =
  'http://www.meatwatch.go.kr/xml/selectDistbHistInfoWsrvDetail.do?SYS_ID=mac7411049&DISTB_IDNTFC_NO=';
var MTRACE_BATCH_URLS = [
  'http://api.mtrace.go.kr/rest/batch/pig/processIn/getBatchInputList',
  'http://api.mtrace.go.kr/rest/batch/pig/marketIn/getBatchInputList',
  'http://api.mtrace.go.kr/rest/batch/cattle/processIn/getBatchInputList',
  'http://api.mtrace.go.kr/rest/batch/cattle/marketIn/getBatchInputList'
];

// optionNo: 1=개체(소)/사육(돼지), 2=출생신고(소), 3=도축(소/돼지),
//           4=포장(소/돼지), 5=구제역백신(소), 6=질병(소), 7=브루셀라(소),
//           8=묶음기본(묶음), 9=묶음구성(묶음)
function callEkape(traceNo, optionNo, corpNo) {
  if (!getTraceServiceKey()) {
    return {ok:false, msg:'EKAPE_TRACE_SERVICE_KEY 또는 MTRACE_API_KEY 스크립트 속성을 설정하세요.'};
  }
  var lastErr = null;
  for (var i = 0; i < EKAPE_URLS.length; i++) {
    var url = buildEkapeUrl(EKAPE_URLS[i], traceNo, optionNo, corpNo);
    try {
      var res = UrlFetchApp.fetch(url, {muteHttpExceptions: true, followRedirects: true});
      var parsed = parseEkapeResponse(res);
      if (parsed.ok || parsed.code) return parsed;
      lastErr = parsed;
    } catch(e) {
      lastErr = {ok: false, msg: 'XML 파싱 오류: ' + e.message};
    }
  }
  return lastErr || {ok:false, msg:'축산물이력제 API 호출 실패'};
}

function callEkapeBatch(traceNo, optionNos, corpNo) {
  var resultMap = {};
  if (!getTraceServiceKey()) {
    optionNos.forEach(function(optionNo) {
      resultMap[optionNo] = {ok:false, msg:'EKAPE_TRACE_SERVICE_KEY 또는 MTRACE_API_KEY 스크립트 속성을 설정하세요.'};
    });
    return resultMap;
  }
  var lastErr = null;
  for (var u = 0; u < EKAPE_URLS.length; u++) {
    var requests = optionNos.map(function(optionNo) {
      return {
        url: buildEkapeUrl(EKAPE_URLS[u], traceNo, optionNo, corpNo),
        muteHttpExceptions: true,
        followRedirects: true
      };
    });
    try {
      var responses = UrlFetchApp.fetchAll(requests);
      var anyOk = false;
      responses.forEach(function(res, idx) {
        var parsed = parseEkapeResponse(res);
        resultMap[optionNos[idx]] = parsed;
        if (parsed.ok) anyOk = true;
        else lastErr = parsed;
      });
      if (anyOk) return resultMap;
    } catch(e) {
      lastErr = {ok:false, msg:'축산물이력제 일괄 조회 오류: ' + e.message};
    }
  }
  optionNos.forEach(function(optionNo) {
    if (!resultMap[optionNo]) resultMap[optionNo] = lastErr || {ok:false, msg:'조회 실패'};
  });
  return resultMap;
}

function buildEkapeUrl(baseUrl, traceNo, optionNo, corpNo) {
  return baseUrl
    + '?serviceKey=' + encodeURIComponent(getTraceServiceKey())
    + '&traceNo='    + encodeURIComponent(traceNo)
    + '&optionNo='   + encodeURIComponent(optionNo)
    + (corpNo ? '&corpNo=' + encodeURIComponent(corpNo) : '');
}

function parseEkapeResponse(res) {
  var status = res.getResponseCode();
  var xml = res.getContentText();
  if (status < 200 || status >= 300) {
    return {ok:false, msg:'HTTP 오류 ' + status, raw: xml.substring(0, 400)};
  }

  try {
    var doc  = XmlService.parse(xml);
    var root = doc.getRootElement();
    var hdr  = childByName(root, 'header');
    var code = hdr ? childText(hdr, 'resultCode') : '';
    var msg  = hdr ? childText(hdr, 'resultMsg')  : '';
    if (code !== '00') return {ok: false, code: code, msg: msg || '조회 실패'};

    var body  = childByName(root, 'body');
    var items = body ? childByName(body, 'items') : null;
    var list  = items ? childrenByName(items, 'item') : [];
    var rows  = list.map(function(item) {
      var obj = {};
      item.getChildren().forEach(function(c) { obj[c.getName()] = c.getText(); });
      return obj;
    });
    return {ok: true, rows: rows};
  } catch(e) {
    return {ok: false, msg: 'XML 파싱 오류: ' + e.message, raw: xml.substring(0, 400)};
  }
}

function childByName(parent, name) {
  if (!parent) return null;
  var children = parent.getChildren();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName() === name) return children[i];
  }
  return null;
}

function childrenByName(parent, name) {
  if (!parent) return [];
  return parent.getChildren().filter(function(c) { return c.getName() === name; });
}

function childText(parent, name) {
  var child = childByName(parent, name);
  return child ? child.getText() : '';
}

function firstTraceField(sources, names) {
  for (var s = 0; s < sources.length; s++) {
    var obj = sources[s] || {};
    for (var n = 0; n < names.length; n++) {
      var val = obj[names[n]];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        return String(val).trim();
      }
    }
  }
  return '';
}

function formatTraceDate(value) {
  var s = String(value || '').replace(/\D/g, '');
  if (s.length >= 8) return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
  return '';
}

function firstEkapeRow(result) {
  return (result && result.ok && result.rows && result.rows.length > 0) ? result.rows[0] : {};
}

function meatwatchText(xml, tagName) {
  var esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp('<"?'+esc+'"?>([\\s\\S]*?)<\\/"?'+esc+'"?>', 'i');
  var m = String(xml || '').match(re);
  return m ? m[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, '').trim() : '';
}

function callMeatwatchDistb(traceNo) {
  if (!traceNo) return {ok:false, msg:'이력번호 없음'};
  try {
    var url = MEATWATCH_DISTB_URL + encodeURIComponent(traceNo);
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      contentType: 'application/x-www-form-urlencoded'
    });
    var status = res.getResponseCode();
    var xml = res.getContentText('UTF-8');
    if (status < 200 || status >= 300) {
      return {ok:false, msg:'MeatWatch HTTP 오류 ' + status, raw: xml.substring(0, 400)};
    }
    var data = {
      source: 'meatwatch',
      traceNo: traceNo,
      processBeginDate: formatTraceDate(meatwatchText(xml, 'prcssBeginDe')),
      processEndDate: formatTraceDate(meatwatchText(xml, 'prcssEndDe')),
      packDate: formatTraceDate(meatwatchText(xml, 'prcssEndDe') || meatwatchText(xml, 'prcssBeginDe')),
      importBlNo: meatwatchText(xml, 'blNo'),
      product: meatwatchText(xml, 'kprodNm'),
      origin: meatwatchText(xml, 'nationNm') || meatwatchText(xml, 'originNm') || meatwatchText(xml, 'cntNm'),
      raw: {meatwatch: xml.substring(0, 1200)}
    };
    if (!data.processBeginDate && !data.processEndDate && !data.importBlNo && !data.product && !data.origin) {
      return {ok:false, msg:'MeatWatch 조회 결과 없음', raw: xml.substring(0, 400)};
    }
    return {ok:true, data:data};
  } catch(e) {
    return {ok:false, msg:'MeatWatch 조회 오류: ' + e.message};
  }
}

function normalizeMtraceYmd(value) {
  var s = String(value || '').replace(/\D/g, '');
  if (s.length >= 8) return s.substring(0, 8);
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyyMMdd');
}

function shiftMtraceYmd(ymd, days) {
  ymd = normalizeMtraceYmd(ymd);
  var d = new Date(Number(ymd.substring(0, 4)), Number(ymd.substring(4, 6)) - 1, Number(ymd.substring(6, 8)));
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyyMMdd');
}

function displayMtraceYmd(ymd) {
  ymd = normalizeMtraceYmd(ymd);
  return ymd.substring(0, 4) + '-' + ymd.substring(4, 6) + '-' + ymd.substring(6, 8);
}

function findFirstDeepXml(parent, name) {
  if (!parent) return null;
  if (parent.getName && parent.getName() === name) return parent;
  var children = parent.getChildren ? parent.getChildren() : [];
  for (var i = 0; i < children.length; i++) {
    var found = findFirstDeepXml(children[i], name);
    if (found) return found;
  }
  return null;
}

function collectMtraceRows(parent, out) {
  if (!parent) return out;
  var name = parent.getName ? parent.getName() : '';
  if (name === 'pigRowData' || name === 'cattleRowData') {
    var obj = {};
    parent.getChildren().forEach(function(c) { obj[c.getName()] = c.getText(); });
    out.push(obj);
  }
  var children = parent.getChildren ? parent.getChildren() : [];
  children.forEach(function(c) { collectMtraceRows(c, out); });
  return out;
}

function parseMtraceResponse(res) {
  var status = res.getResponseCode();
  var xml = res.getContentText();
  if (status < 200 || status >= 300) {
    return {ok:false, msg:'mtrace HTTP error ' + status, raw: xml.substring(0, 400)};
  }
  try {
    var root = XmlService.parse(xml).getRootElement();
    var work = findFirstDeepXml(root, 'workState');
    var checkYn = work ? childText(work, 'checkYn') : '';
    var msg = work ? childText(work, 'checkMsg') : '';
    var rows = collectMtraceRows(root, []);
    if (checkYn && checkYn !== 'Y') return {ok:false, msg: msg || 'mtrace lookup failed', rows: rows};
    return {ok:true, rows: rows, msg: msg};
  } catch(e) {
    return {ok:false, msg:'mtrace XML parse error: ' + e.message, raw: xml.substring(0, 400)};
  }
}

function sameTraceNo(a, b) {
  var x = String(a || '').replace(/\s/g, '').toUpperCase();
  var y = String(b || '').replace(/\s/g, '').toUpperCase();
  return !!x && !!y && x === y;
}

function mtraceGradeText(value) {
  var v = String(value || '').trim();
  var map = {'1':'1++', '2':'1등급', '3':'2등급', '4':'1등급이상', '5':'2등급이상', 'E':'등외'};
  return map[v] || v;
}

function mapMtraceLabel(row, traceNo, url) {
  var ymd = row.butcheryYmd || row.butchYmd || row.outYmd || '';
  return {
    traceNo: traceNo,
    origin: '국내산',
    animalType: url.indexOf('/cattle/') >= 0 ? '소' : '돼지',
    carcassNo: row.cattleNo || row.pigNo || row.lotNo || row.lotPigNo || row.pigLotNo || '',
    packDate: formatTraceDate(row.processYmd || row.outYmd || ''),
    slaughterDate: ymd ? displayMtraceYmd(ymd) : '',
    slaughterHouse: row.butcheryPlaceNm || row.butchPlaceNm || row.outPlaceNm || '',
    grade: mtraceGradeText(row.grade || row.gradeCd || row.qgrade || ''),
    farmName: row.farmNm || row.raiseFarmNm || '',
    raw: {mtrace: row}
  };
}

function findMtraceTraceInfo(traceNo, baseDate) {
  var credentials = getMtraceCredentials();
  if (!credentials.userId || !credentials.apiKey) return null;
  var base = normalizeMtraceYmd(baseDate);
  var today = normalizeMtraceYmd('');
  var windows = [{start: shiftMtraceYmd(base, -9), end: base}];
  if (today !== base) windows.push({start: shiftMtraceYmd(today, -9), end: today});

  var requests = [];
  windows.forEach(function(w) {
    MTRACE_BATCH_URLS.forEach(function(url) {
      var payload = {
        userId: credentials.userId,
        apiKey: credentials.apiKey,
        callType: '',
        outStartYmd: w.start,
        outEndYmd: w.end,
        outType: 'BR|BO|PO|MO',
        outCorpNo: '',
        partCd: ''
      };
      requests.push({
        url: url,
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        followRedirects: true
      });
    });
  });

  try {
    var responses = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < responses.length; i++) {
      var parsed = parseMtraceResponse(responses[i]);
      if (!parsed.ok) continue;
      var url = requests[i].url;
      for (var r = 0; r < parsed.rows.length; r++) {
        var row = parsed.rows[r];
        if (
          sameTraceNo(row.lotPigNo, traceNo) ||
          sameTraceNo(row.pigNo, traceNo) ||
          sameTraceNo(row.cattleNo, traceNo) ||
          sameTraceNo(row.lotNo, traceNo) ||
          sameTraceNo(row.pigLotNo, traceNo)
        ) {
          return mapMtraceLabel(row, traceNo, url);
        }
      }
    }
    return null;
  } catch(e) {
    return {error: 'mtrace lookup error: ' + e.message};
  }
}

// ── 이력번호 조회 메인 함수 ───────────────────────────
function getTraceInfo(traceNo, baseDate) {
  if (!traceNo) return {error: '이력번호를 입력하세요'};
  traceNo = traceNo.replace(/\s/g, '');

  try {
    // 라벨에 필요한 핵심 정보: 1=개체/사육, 3=도축, 4=포장.
    var batch = callEkapeBatch(traceNo, [1, 3, 4], '');
    var r1 = batch[1];  // 개체(소)/사육(돼지)
    var r3 = batch[3];  // 도축
    var r4 = batch[4];  // 포장
    var r8 = {ok:false, rows:[], msg:''};
    var r9 = {ok:false, rows:[], msg:''};

    var d1 = firstEkapeRow(r1);
    var d3 = firstEkapeRow(r3);
    var d4 = firstEkapeRow(r4);
    var d8 = firstEkapeRow(r8);
    var d9 = firstEkapeRow(r9);

    if (!r1.ok && !r3.ok && !r4.ok) {
      // 묶음번호일 수 있으므로 그때만 묶음 조회를 추가 시도한다.
      var bundleBatch = callEkapeBatch(traceNo, [8, 9], '');
      r8 = bundleBatch[8];
      r9 = bundleBatch[9];
      d8 = firstEkapeRow(r8);
      d9 = firstEkapeRow(r9);
    }

    var meatwatch = callMeatwatchDistb(traceNo);

    if (!r1.ok && !r3.ok && !r4.ok && !r8.ok && !r9.ok && !(meatwatch && meatwatch.ok)) {
      var mtrace = findMtraceTraceInfo(traceNo, baseDate);
      if (mtrace && !mtrace.error) return mtrace;
      var msg = r1.msg || r3.msg || r8.msg || r9.msg || '조회 결과 없음';
      if (mtrace && mtrace.error) msg += ' / ' + mtrace.error;
      return {error: msg + ' (공공데이터포털 serviceKey 확인 또는 제조일 기준 최근 10일 mtrace 매입대상 조회 확인 필요)', traceNo: traceNo};
    }

    var label = {};
    label.traceNo    = traceNo;
    label.source     = 'ekape';
    label.origin     = firstTraceField([d1, d3, d4, d8, d9], ['originNm', 'nationNm', 'cntNm']) || '국내산';
    label.product    = firstTraceField([d4, d8, d9, d3, d1], ['kprodNm', 'productNm', 'prductNm', 'itemNm', 'partNm', 'lsTypeNm', 'pigBreedNm']);

    // 개체/사육 정보 (optionNo=1)
    label.birthDate  = formatTraceDate(firstTraceField([d1, d9], ['birthYmd']));
    label.gender     = firstTraceField([d1, d9], ['sexNm']);
    label.breed      = firstTraceField([d1, d9], ['lsTypeNm', 'pigBreedNm']);
    label.farmName   = firstTraceField([d1, d9], ['farmNm', 'raiseFarmNm']);
    // 소/돼지 구분
    label.carcassNo  = firstTraceField([d1, d9], ['cattleNo', 'pigNo', 'animalNo', 'lotNo', 'lotPigNo', 'pigLotNo']);
    label.animalType = firstTraceField([d1, d9], ['cattleNo']) ? '소' :
      (firstTraceField([d1, d9], ['pigNo', 'animalNo', 'lotPigNo', 'pigLotNo']) ? '돼지' : '');

    // 도축 정보 (optionNo=3)
    label.slaughterDate  = formatTraceDate(firstTraceField([d3, d9], ['butchYmd', 'butcheryYmd']));
    label.slaughterHouse = firstTraceField([d3, d9], ['butchPlaceNm', 'butcheryPlaceNm']);
    label.inspectResult  = firstTraceField([d3, d9], ['inspectPassYn', 'butchPassYn']);
    label.grade          = firstTraceField([d3, d9], ['gradeNm', 'qgrade', 'gradeCd']);
    label.gradeDate      = formatTraceDate(firstTraceField([d3, d9], ['gradeYmd']));

    // 포장 정보 (optionNo=4)
    label.packDate    = formatTraceDate(firstTraceField([d4, d8], ['packYmd', 'processYmd']));
    label.packCompany = firstTraceField([d4, d8], ['packPlaceNm', 'processPlaceNm']);

    if (meatwatch && meatwatch.ok) {
      var mw = meatwatch.data;
      label.source = label.source + '+meatwatch';
      label.origin = mw.origin || label.origin || '수입산';
      label.product = label.product || mw.product;
      label.packDate = label.packDate || mw.packDate;
      label.processBeginDate = mw.processBeginDate;
      label.processEndDate = mw.processEndDate;
      label.importBlNo = mw.importBlNo;
    }

    // 원본 보관 (필드명 확인용)
    label.raw = {opt1: d1, opt3: d3, opt4: d4, opt8: d8, opt9: d9, meatwatch: meatwatch};

    return label;

  } catch(err) {
    return {error: '조회 중 오류 발생: ' + err.message};
  }
}

// ── 디버그: 전체 결과 확인 ────────────────────────────
function debugTrace() {
  var result = getTraceInfo('120017700236');
  Logger.log(JSON.stringify(result, null, 2));
}

// ── 디버그: optionNo별 XML 원본 필드명 확인 ──────────
function debugTrace2() {
  var traceNo = '120017700236';
  [1, 3, 4].forEach(function(opt) {
    var r = callEkape(traceNo, opt, '');
    Logger.log('=== optionNo=' + opt + ' ok=' + r.ok + ' ===');
    if (r.ok) {
      Logger.log(JSON.stringify(r.rows[0] || {}, null, 2));
    } else {
      Logger.log('오류: ' + r.msg + (r.raw ? '\n' + r.raw : ''));
    }
  });
}

// ── 시트 가져오기 (없으면 생성) ────────────────────────
function getOrCreate(name, ss) {
  ss = ss || openDbSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
