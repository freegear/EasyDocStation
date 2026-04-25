export const FORM_TEMPLATES = [
  {
    id: 'quotation',
    label: '견적서',
    icon: '📋',
    content: `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>견적서 (실리콘큐브)</title>
<style>
* { box-sizing: border-box; }
body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; margin: 0; padding: 30px; color: #222; font-size: 13px; }
.wrap { max-width: 860px; margin: auto; }

/* 상단 견적번호 + 로고 */
.top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 12px; color: #555; }

/* 제목 */
.title-row { text-align: center; font-size: 30px; font-weight: bold; letter-spacing: 16px; padding: 10px 0 6px; border-top: 2px solid #222; border-bottom: 1px solid #aaa; margin-bottom: 12px; }
.date-row { font-size: 12px; margin-bottom: 14px; }
.date-row strong { font-weight: bold; }

/* 수신/공급자 2단 레이아웃 */
.info-section { display: flex; gap: 16px; margin-bottom: 14px; }
.recv-table, .supp-table { border-collapse: collapse; font-size: 12px; }
.recv-table { flex: 0 0 auto; }
.supp-table { flex: 1; }
.recv-table td, .supp-table td { border: 1px solid #aaa; padding: 5px 8px; }
.recv-table .lbl { background: #f5f5f5; font-weight: bold; width: 56px; text-align: center; white-space: nowrap; }
.supp-table .lbl { background: #f5f5f5; font-weight: bold; width: 44px; text-align: center; white-space: nowrap; }
.supp-name-cell { font-weight: bold; }
.seal-img { width: 64px; height: 64px; object-fit: contain; vertical-align: middle; margin-left: 4px; opacity: 0.9; position: absolute; top: -10px; right: -10px; }

/* 소요비용 문구 */
.intro { font-weight: bold; margin-bottom: 12px; font-size: 13px; }

/* 합계 강조 */
.sum-bar { display: flex; border: 1.5px solid #222; margin-bottom: 16px; }
.sum-bar .sum-lbl { background: #222; color: #fff; font-weight: bold; padding: 10px 24px; font-size: 14px; letter-spacing: 4px; }
.sum-bar .sum-val { flex: 1; padding: 10px 20px; font-weight: bold; font-size: 15px; }

/* 견적명 */
.estimate-name { margin-bottom: 6px; font-size: 13px; }

/* 명세 테이블 */
.detail-header { display: flex; justify-content: flex-end; font-size: 11px; color: #555; margin-bottom: 2px; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 0; }
.detail-table th { background: #444; color: #fff; padding: 7px 4px; border: 1px solid #444; text-align: center; }
.detail-table td { border: 1px solid #bbb; padding: 6px 4px; text-align: center; vertical-align: top; }
.detail-table td.desc { text-align: left; padding-left: 6px; }
.detail-table .subtotal-row td { background: #f0f0f0; font-weight: bold; text-align: right; padding-right: 10px; }
.detail-table .vat-row td { background: #f7f7f7; text-align: right; padding-right: 10px; }
.detail-table td.amount { font-weight: bold; }
.detail-table .sum-label { text-align: center; font-weight: bold; letter-spacing: 4px; background: #f0f0f0; }

/* REMARK */
.remark { margin-top: 16px; font-size: 11.5px; color: #333; }
.remark strong { color: #c00; }
.remark p { margin: 2px 0; }

/* 하단 */
.footer { margin-top: 20px; border-top: 1px solid #ccc; padding-top: 8px; font-size: 11px; color: #888; display: flex; justify-content: space-between; }

/* 편집 가능 */
.editable { cursor: pointer; position: relative; transition: background 0.12s; }
.editable:hover { background: #eef2ff !important; outline: 1px dashed #818cf8; }
.editable::after { content: '✏'; font-size: 8px; color: #a5b4fc; position: absolute; top: 1px; right: 2px; opacity: 0; }
.editable:hover::after { opacity: 1; }
.doc-no-readonly { background: #f3f4f6; color: #374151; font-weight: 600; letter-spacing: 0.03em; }

/* 팝업 */
#_popup { position: fixed; background: #fff; border: 2px solid #4f46e5; border-radius: 8px; padding: 7px 10px; box-shadow: 0 6px 20px rgba(79,70,229,0.2); z-index: 9999; display: flex; gap: 6px; align-items: center; }
#_popup::after { content: ''; position: absolute; top: 100%; left: 14px; border: 5px solid transparent; border-top-color: #4f46e5; }
#_popup input { border: none; outline: none; font-family: inherit; font-size: 0.88em; min-width: 180px; color: #1e1b4b; }
#_popup textarea { border: none; outline: none; font-family: inherit; font-size: 0.88em; width: 340px; min-height: 80px; resize: vertical; color: #1e1b4b; line-height: 1.5; }
#_popup button { background: #4f46e5; color: #fff; border: none; border-radius: 4px; padding: 3px 10px; font-size: 0.8em; cursor: pointer; white-space: nowrap; align-self: flex-start; }
#_popup button:hover { background: #4338ca; }

@media print {
  .no-print { display: none; }
  .editable::after { display: none; }
  body { padding: 10px; }
  #_popup { display: none; }
}
</style>
</head>
<body>
<div class="wrap">

  <!-- 견적번호 + 로고 -->
  <div class="top-bar">
    <span>견적번호 : <span class="editable" data-type="no" style="display:inline-block;padding:1px 4px;">SCSADOM-20231213001</span></span>
    <img src="{{LOGO_URL}}" alt="SiliconCube" style="height:40px;object-fit:contain;" />
  </div>

  <!-- 제목 -->
  <div class="title-row">견 &nbsp;&nbsp; 적 &nbsp;&nbsp; 서</div>
  <div class="date-row">견적일자 : &nbsp;<span id="quote-date" class="editable" style="display:inline-block;padding:1px 4px;"></span></div>

  <!-- 수신 + 공급자 -->
  <div class="info-section">
    <table class="recv-table">
      <tr><td class="lbl">수 &nbsp;신</td><td class="editable" data-field="recv" style="width:140px;">뷰아이</td></tr>
      <tr><td class="lbl">참 &nbsp;조</td><td class="editable"></td></tr>
      <tr><td class="lbl">전화번호</td><td class="editable"></td></tr>
      <tr><td class="lbl">팩 &nbsp;스</td><td class="editable"></td></tr>
      <tr><td class="lbl">전자메일</td><td class="editable"></td></tr>
    </table>

    <table class="supp-table">
      <tr>
        <td class="lbl">상 호</td>
        <td class="supp-name-cell" style="min-width:130px;">주식회사 실리콘큐브</td>
        <td class="lbl">대 표</td>
        <td style="position:relative; min-width:100px;">임 종 윤<img src="{{SEAL_URL}}" class="seal-img" alt="인장" /></td>
      </tr>
      <tr>
        <td class="lbl">주 소</td>
        <td colspan="3" class="editable">경기도 성남시 수정구 창업로 54<br>LH 판교기업성장센터 731~735호</td>
      </tr>
      <tr>
        <td class="lbl">전 화</td>
        <td class="editable">031-697-8270</td>
        <td class="lbl">팩 스</td>
        <td class="editable">031-697-8271</td>
      </tr>
      <tr>
        <td class="lbl">담당자</td>
        <td colspan="3" class="editable">{{USER_NAME}}<br>({{USER_EMAIL}})</td>
      </tr>
    </table>
  </div>

  <div class="intro">소요비용에 대한 견적을 아래와 같이 제출합니다.</div>

  <!-- 합계 강조 -->
  <div class="sum-bar">
    <div class="sum-lbl">합 &nbsp; 계</div>
    <div class="sum-val editable" id="sum-bar-amount">60,000,000 원 &nbsp;(VAT 별도)</div>
  </div>

  <!-- 견적명 -->
  <div class="estimate-name">□ 견적명 : <span class="editable" data-field="estimate-name" style="display:inline-block;min-width:200px;padding:1px 4px;">NX AI 모듈 공급건</span></div>
  <div class="estimate-name" style="margin-bottom:4px;">□ 견적상세</div>
  <div class="detail-header">[ 단위 : KRW ]</div>

  <!-- 명세 테이블 -->
  <table class="detail-table">
    <thead>
      <tr>
        <th style="width:36px;">구분</th>
        <th>품목명 / 규격</th>
        <th style="width:34px;">단위</th>
        <th style="width:34px;">수 량</th>
        <th style="width:80px;">단 가</th>
        <th style="width:80px;">공급가액</th>
        <th style="width:130px;">비 고</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="editable">1</td>
        <td class="desc editable">Beaueye Implant 이식 전후 시뮬레이션 안드로이드 앱 개발</td>
        <td class="editable">식</td>
        <td class="editable" data-role="qty">1</td>
        <td class="editable" data-role="unit-price">60,000,000</td>
        <td class="editable amount" data-role="supply-amount">60,000,000</td>
        <td class="desc editable"></td>
      </tr>
      <tr>
        <td class="editable">1-1</td>
        <td class="desc editable">가. 시뮬레이션 앱을 위한 UI디자인<br>&nbsp;&nbsp;- 직관적으로 사용이 가능한 UI 디자인</td>
        <td></td><td></td><td></td><td></td>
        <td class="desc editable" style="font-size:11px;">1) 개발 기간 : 발주 후 6개월</td>
      </tr>
      <tr>
        <td class="editable">1-2</td>
        <td class="desc editable">나. Beaueye Implant 이식 전후에 대한 AI 엔진 개발<br>&nbsp;&nbsp;- 입력된 사진에서 눈동자의 인식을 할 수 있는 AI 엔진 개발<br>&nbsp;&nbsp;- +/- 200의 각도에서 눈동자를 인식<br>&nbsp;&nbsp;- 각도에 따른 눈동자의 변형된 원형 인식</td>
        <td></td><td></td><td></td><td></td>
        <td class="desc editable" style="font-size:11px;">2) 타겟 플랫폼<br>&nbsp;- 운영 체제의 기본 설정 : Android<br><br>3) 수행 결과물 : Android 기반 App<br>&nbsp;- AI 기반 눈동자 인식 기능 추가<br>&nbsp;- AI 기반 임플란트 이식 전 후 비교 영상 생성</td>
      </tr>
      <tr>
        <td class="editable">1-3</td>
        <td class="desc editable">다. AI 기반 Beaueye Implant 이식 전후 시뮬레이션 앱 개발<br>&nbsp;&nbsp;- 눈동자와 임플란트(링형태) 사이즈의 간격 조정 (3단계 기본 설정, 협의 가능)<br>&nbsp;&nbsp;- 눈동자와 임플란트(링형태) 두께 조정 (3단계로 기본 설정, 협의 가능)<br>&nbsp;&nbsp;- 눈동자와 임플란트(링형태) 색상 조정 (4가지 색상 옵션: 검정,갈색,녹색,파랑)</td>
        <td></td><td></td><td></td><td></td>
        <td class="desc editable" style="font-size:11px;">- 옵션 반영<br>&nbsp;i. 임플란트(링형태)와 눈동자의 간격 설정<br>&nbsp;ii. 임플란트(링형태)의 두께 설정<br>&nbsp;iii. 임플란트(링형태)의 색상</td>
      </tr>
      <tr><td class="editable">&nbsp;</td><td class="desc editable"></td><td class="editable"></td><td class="editable" data-role="qty"></td><td class="editable" data-role="unit-price"></td><td class="editable amount" data-role="supply-amount"></td><td class="editable"></td></tr>
      <tr><td class="editable">&nbsp;</td><td class="desc editable"></td><td class="editable"></td><td class="editable" data-role="qty"></td><td class="editable" data-role="unit-price"></td><td class="editable amount" data-role="supply-amount"></td><td class="editable"></td></tr>
      <tr><td class="editable">&nbsp;</td><td class="desc editable"></td><td class="editable"></td><td class="editable" data-role="qty"></td><td class="editable" data-role="unit-price"></td><td class="editable amount" data-role="supply-amount"></td><td class="editable"></td></tr>
      <tr>
        <td colspan="4" class="sum-label">합 &nbsp; 계</td>
        <td></td>
        <td class="amount" id="subtotal-amount">60,000,000</td>
        <td></td>
      </tr>
      <tr class="vat-row">
        <td colspan="5" style="text-align:right;padding-right:10px;">VAT(10%) 포함가</td>
        <td class="amount" id="vat-amount">66,000,000</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <!-- REMARK -->
  <div class="remark">
    <p><strong>* REMARK</strong></p>
    <p class="editable" style="display:block;">※ 견적유효기간 : 견적 후 15일 이내</p>
    <p class="editable" style="display:block;">※ 납기 : 별도 협의</p>
    <p class="editable" style="display:block;">※ 납품장소 : 고객 지정 장소</p>
    <p class="editable" style="display:block;">※ 결제조건 : 계약 시 100% 선지급</p>
    <p class="editable" style="display:block;">※ 기타사항 :</p>
  </div>

  <!-- 하단 -->
  <div class="footer">
    <span>COPYRIGHT© 2018 Siliconcube Co., Ltd. All rights reserved.</span>
    <span>www.siliconcube.co.kr</span>
  </div>
</div>

<div class="no-print" style="text-align:center;margin-top:20px;">
  <button id="print-btn" onclick="window.printExpense()" style="padding:10px 24px;cursor:pointer;border:1px solid #aaa;border-radius:4px;background:#fff;font-size:13px;">PDF로 저장 / 인쇄하기</button>
</div>

<script>
(function() {
  function todayNo() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth()+1).padStart(2,'0');
    var day = String(d.getDate()).padStart(2,'0');
    return 'SCSADOM-' + y + m + day + '001';
  }

  function parseNum(s) { return parseFloat((s || '0').replace(/[,\s원]/g, '')) || 0; }
  function fmtNum(n) { return Math.round(n).toLocaleString('ko-KR'); }

  function recalcRow(row) {
    var qtyEl = row.querySelector('[data-role="qty"]');
    var priceEl = row.querySelector('[data-role="unit-price"]');
    var amountEl = row.querySelector('[data-role="supply-amount"]');
    if (qtyEl && priceEl && amountEl) {
      var qty = parseNum(qtyEl.textContent);
      var price = parseNum(priceEl.textContent);
      if (qty && price) amountEl.textContent = fmtNum(qty * price);
    }
  }

  function recalcTotals() {
    var total = 0;
    document.querySelectorAll('[data-role="supply-amount"]').forEach(function(a) {
      total += parseNum(a.textContent);
    });
    var subtotalEl = document.getElementById('subtotal-amount');
    var vatEl = document.getElementById('vat-amount');
    var sumBarEl = document.getElementById('sum-bar-amount');
    if (subtotalEl) subtotalEl.textContent = fmtNum(total);
    if (vatEl) vatEl.textContent = fmtNum(Math.round(total * 1.1));
    if (sumBarEl) sumBarEl.textContent = fmtNum(total) + ' 원 \u00a0(VAT 별도)';
  }

  function closePopup() {
    var p = document.getElementById('_popup');
    if (p) p.remove();
  }

  function openInput(el) {
    closePopup();
    var isNo = el.dataset.type === 'no';
    var isMultiline = !isNo && el.innerHTML.indexOf('<br>') !== -1;
    var defaultVal = isNo ? todayNo() : el.innerText.trim();

    var popup = document.createElement('div');
    popup.id = '_popup';
    popup.style.alignItems = isMultiline ? 'flex-start' : 'center';

    var field = isMultiline ? document.createElement('textarea') : document.createElement('input');
    field.value = defaultVal;
    if (!isMultiline) field.style.minWidth = '200px';

    var btn = document.createElement('button');
    btn.textContent = '확인';
    btn.onclick = function() {
      if (isMultiline) {
        el.innerHTML = field.value.replace(/\\n/g, '<br>');
      } else {
        el.textContent = field.value;
      }
      closePopup();
      // 수량 또는 단가 변경 → 공급가액 자동계산
      var role = el.dataset.role;
      if (role === 'qty' || role === 'unit-price') {
        var row = el.closest('tr');
        if (row) recalcRow(row);
        recalcTotals();
      }
      if (isNo) {
        window.parent.postMessage({ type: 'templateFieldChanged', field: 'quoteNo', value: field.value }, '*');
      } else if (el.dataset.field === 'recv') {
        window.parent.postMessage({ type: 'templateFieldChanged', field: 'recv', value: field.value }, '*');
      } else if (el.dataset.field === 'estimate-name') {
        window.parent.postMessage({ type: 'templateFieldChanged', field: 'estimateName', value: field.value }, '*');
      }
    };

    popup.appendChild(field);
    popup.appendChild(btn);
    document.body.appendChild(popup);

    var rect = el.getBoundingClientRect();
    var popH = popup.offsetHeight || 42;
    var top = rect.top - popH - 10;
    if (top < 4) top = rect.bottom + 10;
    popup.style.top = top + 'px';
    popup.style.left = Math.max(4, rect.left) + 'px';

    field.focus();
    if (field.select) field.select();
    field.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !isMultiline) btn.onclick();
      if (e.key === 'Escape') closePopup();
    });
    setTimeout(function() {
      document.addEventListener('click', function h(e) {
        if (!popup.contains(e.target) && e.target !== el) { closePopup(); document.removeEventListener('click', h); }
      });
    }, 0);
  }

  // 오늘 날짜 초기 설정
  var dateEl = document.getElementById('quote-date');
  if (dateEl) {
    var dn = new Date();
    dateEl.textContent = dn.getFullYear() + '년 ' + (dn.getMonth()+1) + '월 ' + dn.getDate() + '일';
  }

  document.querySelectorAll('.editable').forEach(function(el) {
    el.addEventListener('click', function(e) { e.stopPropagation(); openInput(el); });
  });
})();
</script>
</body>
</html>`,
  },
  {
    id: 'trip-report',
    label: '출장보고서',
    icon: '✈️',
    content: `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>출장보고서 (실리콘큐브)</title>
<style>
* { box-sizing: border-box; }
body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; margin: 0; padding: 40px; color: #333; font-size: 13px; line-height: 1.6; background: #f5f5f5; }
.wrap { max-width: 800px; margin: auto; background: #fff; padding: 50px; border: 1px solid #ddd; box-shadow: 0 0 20px rgba(0,0,0,0.1); }

/* 결재란 */
.approval-table { float: right; border-collapse: collapse; margin-bottom: 10px; }
.approval-table td { border: 1px solid #333; width: 70px; height: 80px; text-align: center; font-size: 0.8em; vertical-align: top; padding-top: 5px; }
.approval-table .title-cell { height: 25px; background: #f9f9f9; padding: 4px 0; }
.approval-table .side-cell { width: 22px; vertical-align: middle; padding: 0; font-size: 11px; line-height: 1.4; background: #f2f2f2; }

/* 헤더 */
.header { text-align: center; margin-bottom: 30px; overflow: hidden; }
.header h1 { font-size: 28px; letter-spacing: 15px; margin: 10px 0 0; padding-bottom: 10px; border-bottom: 3px double #333; display: inline-block; }

/* 기본정보 테이블 */
.info-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
.info-table th, .info-table td { border: 1px solid #333; padding: 10px 12px; }
.info-table th { background: #f2f2f2; font-weight: bold; width: 100px; text-align: center; white-space: nowrap; }

/* 섹션 */
.section-title { font-size: 16px; font-weight: bold; border-left: 5px solid #333; padding-left: 10px; margin: 24px 0 8px; }
.section-body { border: 1px solid #ccc; padding: 14px; min-height: 70px; font-size: 13px; }

/* 내부 테이블 */
.inner-table { width: 100%; border-collapse: collapse; }
.inner-table th { background: #f2f2f2; border: 1px solid #333; padding: 8px; text-align: center; font-weight: bold; }
.inner-table td { border: 1px solid #ccc; padding: 8px; text-align: center; vertical-align: top; }
.inner-table td.left { text-align: left; }

/* 하단 */
.footer-text { text-align: center; margin-top: 40px; font-weight: bold; font-size: 14px; }
.sign-row { text-align: center; margin-top: 6px; font-size: 13px; }

/* 편집 */
.editable { cursor: pointer; position: relative; transition: background 0.12s; }
.editable:hover { background: #eef2ff !important; outline: 1px dashed #818cf8; }
.editable::after { content: '✏'; font-size: 8px; color: #a5b4fc; position: absolute; top: 1px; right: 2px; opacity: 0; }
.editable:hover::after { opacity: 1; }

/* 팝업 */
#_popup { position: fixed; background: #fff; border: 2px solid #4f46e5; border-radius: 8px; padding: 7px 10px; box-shadow: 0 6px 20px rgba(79,70,229,0.2); z-index: 9999; display: flex; gap: 6px; align-items: center; }
#_popup::after { content: ''; position: absolute; top: 100%; left: 14px; border: 5px solid transparent; border-top-color: #4f46e5; }
#_popup input { border: none; outline: none; font-family: inherit; font-size: 0.88em; min-width: 200px; color: #1e1b4b; }
#_popup textarea { border: none; outline: none; font-family: inherit; font-size: 0.88em; width: 320px; height: 80px; resize: vertical; color: #1e1b4b; }
#_popup button { background: #4f46e5; color: #fff; border: none; border-radius: 4px; padding: 3px 10px; font-size: 0.8em; cursor: pointer; white-space: nowrap; align-self: flex-start; }
#_popup button:hover { background: #4338ca; }

@media print {
  body { background: white; padding: 0; }
  .wrap { border: none; box-shadow: none; }
  .no-print { display: none; }
  .editable::after { display: none; }
  #_popup { display: none; }
}
</style>
</head>
<body>
<div class="wrap">

  <!-- 결재란 (우측 상단) -->
  <table class="approval-table">
    <tr>
      <td rowspan="2" class="side-cell">결<br>재</td>
      <td class="title-cell">담당</td>
      <td class="title-cell">검토</td>
      <td class="title-cell">승인</td>
    </tr>
    <tr>
      <td class="editable">&nbsp;</td>
      <td class="editable">&nbsp;</td>
      <td class="editable">&nbsp;</td>
    </tr>
  </table>

  <!-- 제목 -->
  <div class="header">
    <h1>출 &nbsp;장 &nbsp;보 &nbsp;고 &nbsp;서</h1>
  </div>

  <!-- 기본 정보 -->
  <table class="info-table">
    <tr>
      <th>문서 번호</th>
      <td colspan="3" class="doc-no-readonly" id="trip-doc-no"> </td>
    </tr>
    <tr>
      <th>성 명</th>
      <td class="editable">{{USER_NAME}}</td>
      <th>소 속</th>
      <td class="editable">영업 1팀</td>
    </tr>
    <tr>
      <th>출장 목적</th>
      <td colspan="3" class="editable">신규 프로젝트 기술 협의 및 사이트 조사</td>
    </tr>
    <tr>
      <th>출장 기간</th>
      <td colspan="3" class="editable" id="trip-date"></td>
    </tr>
    <tr>
      <th>출장지</th>
      <td colspan="3" class="editable">부산광역시 (OO하이테크 본사)</td>
    </tr>
  </table>

  <!-- 섹션 1 -->
  <div class="section-title">1. 주요 수행 업무</div>
  <div class="section-body">
    <table class="inner-table">
      <tr>
        <td class="left editable">- 신규 자동화 라인 도입 관련 기술 사전 협의<br>- 현장 설치 환경 측정 및 인터뷰 진행<br>- 협력사 담당자 미팅 (현지 일정 조율)</td>
      </tr>
    </table>
  </div>

  <!-- 섹션 2 -->
  <div class="section-title">2. 출장 결과 및 성과</div>
  <div class="section-body">
    <table class="inner-table">
      <tr>
        <td class="left editable">- 기술 사전의 1차 합의 완료 (6월 중 최종 결정 예정)<br>- 기존 인프라 활용 방식 확인을 통한 비용 절감 가능성 확인<br>- 고객사 측의 긍정적인 반응 의지 확인</td>
      </tr>
    </table>
  </div>

  <!-- 섹션 3 세부 활동 -->
  <div class="section-title">3. 세부 활동 내역</div>
  <div class="section-body" style="padding:0;">
    <table class="inner-table">
      <thead>
        <tr><th style="width:100px;">날짜</th><th style="width:160px;">장소</th><th>활동내용</th><th style="width:80px;">비고</th></tr>
      </thead>
      <tbody>
        <tr>
          <td class="editable" id="act-date-1"></td>
          <td class="editable">OO하이테크 본사</td>
          <td class="left editable">기술 협의 미팅</td>
          <td class="editable">-</td>
        </tr>
        <tr>
          <td class="editable" id="act-date-2"></td>
          <td class="editable">현장</td>
          <td class="left editable">설치 환경 실사</td>
          <td class="editable">-</td>
        </tr>
        <tr>
          <td class="editable">&nbsp;</td>
          <td class="editable"></td>
          <td class="left editable"></td>
          <td class="editable"></td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 섹션 4 비용 -->
  <div class="section-title">4. 비용 내역</div>
  <div class="section-body" style="padding:0;">
    <table class="inner-table">
      <thead>
        <tr><th>항목</th><th>금액</th><th>비고</th></tr>
      </thead>
      <tbody>
        <tr><td class="editable">교통비</td><td class="editable">₩ 45,000</td><td class="editable">KTX 왕복</td></tr>
        <tr><td class="editable">숙박비</td><td class="editable">₩ 80,000</td><td class="editable">1박</td></tr>
        <tr><td class="editable">식비</td><td class="editable">₩ 30,000</td><td class="editable">-</td></tr>
        <tr>
          <td style="font-weight:bold;background:#f9f9f9;">합계</td>
          <td class="editable" style="font-weight:bold;">₩ 155,000</td>
          <td class="editable">-</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 섹션 5 향후 계획 -->
  <div class="section-title">5. 향후 계획 및 특이사항</div>
  <div class="section-body">
    <table class="inner-table">
      <tr>
        <td class="left editable">- 현장 조사 데이터를 바탕으로 견적 재검토 예정<br>- 차주 수요일 화상 회의를 통한 협의 조치 마련</td>
      </tr>
    </table>
  </div>

  <!-- 하단 서명 -->
  <p class="footer-text">위와 같이 출장 결과를 보고합니다.</p>
  <p class="sign-row" id="report-date"></p>
  <p class="sign-row">보고자 : <span class="editable" style="display:inline-block;min-width:80px;padding:0 4px;">{{USER_NAME}}</span> (인)</p>

</div>

<div class="no-print" style="text-align:center;margin-top:24px;">
  <button id="print-btn" onclick="window.printExpense()" style="padding:10px 24px;cursor:pointer;border:1px solid #aaa;border-radius:4px;background:#fff;font-size:13px;">PDF로 저장 / 인쇄하기</button>
</div>

<script>
(function() {
  /* 오늘 날짜 초기화 */
  function fmt(d) {
    return d.getFullYear() + '년 ' + (d.getMonth()+1) + '월 ' + d.getDate() + '일';
  }
  var today = new Date();
  var tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);

  var tripDate = document.getElementById('trip-date');
  if (tripDate) tripDate.textContent = fmt(today) + ' ~ ' + fmt(tomorrow) + ' (1박 2일)';

  var actDate1 = document.getElementById('act-date-1');
  if (actDate1) actDate1.textContent = (today.getMonth()+1) + '월 ' + today.getDate() + '일';

  var actDate2 = document.getElementById('act-date-2');
  if (actDate2) actDate2.textContent = (tomorrow.getMonth()+1) + '월 ' + tomorrow.getDate() + '일';

  var reportDate = document.getElementById('report-date');
  if (reportDate) reportDate.textContent = fmt(today);
  var tripDocNo = document.getElementById('trip-doc-no');
  if (tripDocNo && !tripDocNo.textContent.trim() && window.TRIP_DOC_NO) {
    tripDocNo.textContent = window.TRIP_DOC_NO;
    window.parent.postMessage({ type: 'templateFieldChanged', field: 'trip-doc-no', value: window.TRIP_DOC_NO }, '*');
  }

  /* 팝업 */
  function closePopup() {
    var p = document.getElementById('_popup');
    if (p) p.remove();
  }

  function openInput(el) {
    closePopup();
    var isMultiline = el.innerHTML.indexOf('<br>') !== -1 || el.offsetHeight > 40;
    var currentVal = el.innerText.trim();

    var popup = document.createElement('div');
    popup.id = '_popup';

    var field;
    if (isMultiline) {
      field = document.createElement('textarea');
      field.value = currentVal;
    } else {
      field = document.createElement('input');
      field.value = currentVal;
    }

    var btn = document.createElement('button');
    btn.textContent = '확인';
    btn.onclick = function() {
      if (isMultiline) {
        el.innerHTML = field.value.replace(/\\n/g, '<br>');
      } else {
        el.textContent = field.value;
      }
      closePopup();
    };

    popup.appendChild(field);
    popup.appendChild(btn);
    document.body.appendChild(popup);

    var rect = el.getBoundingClientRect();
    var popH = popup.offsetHeight || 44;
    var top = rect.top - popH - 10;
    if (top < 4) top = rect.bottom + 10;
    popup.style.top = top + 'px';
    popup.style.left = Math.max(4, rect.left) + 'px';

    field.focus();
    if (field.select) field.select();

    field.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !isMultiline) btn.onclick();
      if (e.key === 'Escape') closePopup();
    });

    setTimeout(function() {
      document.addEventListener('click', function h(e) {
        if (!popup.contains(e.target) && e.target !== el) {
          closePopup();
          document.removeEventListener('click', h);
        }
      });
    }, 0);
  }

  document.querySelectorAll('.editable').forEach(function(el) {
    el.addEventListener('click', function(e) { e.stopPropagation(); openInput(el); });
  });
})();
</script>
</body>
</html>`,
  },
  {
    id: 'expense-report',
    label: '지출결의서',
    icon: '💰',
    content: `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>지출결의서 (지급품의)</title>
<style>
* { box-sizing: border-box; }
body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; margin: 0; padding: 30px; color: #222; font-size: 13px; background: #f5f5f5; }
.wrap { max-width: 800px; margin: auto; background: #fff; padding: 40px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }

h1 { text-align: center; font-size: 28px; letter-spacing: 12px; margin-bottom: 24px; font-weight: bold; }

.header-area { overflow: hidden; margin-bottom: 16px; }
.header-left { float: left; }
.header-right { float: right; }
.clear { clear: both; }

.meta-table { border-collapse: collapse; font-size: 13px; }
.meta-table td { border: 1px solid #333; padding: 5px 10px; height: 30px; }
.meta-table .lbl { background: #d9d9d9; font-weight: bold; width: 80px; text-align: center; }

.approval-table { border-collapse: collapse; font-size: 12px; }
.approval-table th { border: 1px solid #333; background: #f2f2f2; width: 28px; text-align: center; vertical-align: middle; font-size: 11px; line-height: 1.6; }
.approval-table td { border: 1px solid #333; width: 100px; text-align: center; }
.approval-table .ap-title { height: 22px; font-size: 11px; background: #f9f9f9; }
.approval-table .ap-sign  { height: 64px; vertical-align: middle; }
.approval-table .ap-date  { height: 22px; font-size: 10px; }

.review-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
.review-table td { border: 1px solid #333; padding: 6px 10px; }
.review-table .lbl { background: #d9d9d9; font-weight: bold; width: 80px; text-align: center; }

.main-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.main-table th { background: #d9d9d9; border: 1px solid #333; padding: 7px 6px; text-align: center; font-weight: bold; }
.main-table td { border: 1px solid #333; padding: 6px 8px; height: 34px; }
.bg-yellow { background: #fff9c4 !important; }
.bg-pink   { background: #f8e0e0 !important; }
.foot-lbl  { font-weight: bold; text-align: center; background: #fff; }

/* 편집 */
.editable { cursor: pointer; position: relative; transition: background 0.12s; }
.editable:hover { background: #eef2ff !important; outline: 1px dashed #818cf8; }
.editable::after { content: '✏'; font-size: 8px; color: #a5b4fc; position: absolute; top: 1px; right: 2px; opacity: 0; }
.editable:hover::after { opacity: 1; }
/* 읽기 전용 문서번호 */
.doc-no-readonly { background: #f3f4f6; color: #374151; font-weight: 600; letter-spacing: 0.03em; }

/* 팝업 */
#_popup { position: fixed; background: #fff; border: 2px solid #4f46e5; border-radius: 8px; padding: 7px 10px; box-shadow: 0 6px 20px rgba(79,70,229,0.2); z-index: 9999; display: flex; gap: 6px; align-items: center; }
#_popup::after { content: ''; position: absolute; top: 100%; left: 14px; border: 5px solid transparent; border-top-color: #4f46e5; }
#_popup input { border: none; outline: none; font-family: inherit; font-size: 0.88em; min-width: 180px; color: #1e1b4b; }
#_popup textarea { border: none; outline: none; font-family: inherit; font-size: 0.88em; width: 320px; height: 80px; resize: vertical; color: #1e1b4b; }
#_popup button { background: #4f46e5; color: #fff; border: none; border-radius: 4px; padding: 3px 10px; font-size: 0.8em; cursor: pointer; white-space: nowrap; align-self: flex-start; }
#_popup button:hover { background: #4338ca; }

/* OCR 버튼 */
.ocr-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
#ocr-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; background: #4f46e5; color: #fff; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; font-family: inherit; }
#ocr-btn:hover { background: #4338ca; }
#ocr-btn:disabled { background: #a5b4fc; cursor: not-allowed; }
#ocr-status { font-size: 11px; color: #6b7280; }
#ocr-img-preview { max-height: 60px; border-radius: 4px; border: 1px solid #ddd; display: none; }

/* 첨부 이미지 페이지 */
.attachment-pages-wrap { margin-top: 24px; display: flex; flex-direction: column; align-items: center; gap: 24px; }
.document-page {
  width: 800px; height: 1100px;
  background-color: #fff;
  border: 1px solid #000;
  padding: 40px;
  box-sizing: border-box;
  box-shadow: 0 0 10px rgba(0,0,0,0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  page-break-before: always;
}
.document-page img { max-width: 720px; max-height: 1020px; width: auto; height: auto; object-fit: contain; display: block; }

@page { margin: 0; }
@media print {
  .no-print { display: none; }
  body { padding: 0 !important; background: #fff; }
  .wrap { box-shadow: none; }
  #_popup { display: none; }
  .attachment-pages-wrap {
    margin: 0 !important;
    padding: 0 !important;
    gap: 0 !important;
  }
  .document-page {
    width: 210mm !important;
    height: 297mm !important;
    max-width: 210mm !important;
    max-height: 297mm !important;
    margin: 0 !important;
    padding: 15mm !important;
    box-sizing: border-box !important;
    box-shadow: none !important;
    border: none !important;
    overflow: hidden !important;
    page-break-before: always !important;
    break-before: page !important;
    page-break-after: avoid !important;
    break-after: avoid !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
  }
  .document-page img {
    max-width: 180mm !important;
    max-height: 267mm !important;
    width: auto !important;
    height: auto !important;
    object-fit: contain !important;
  }
}
</style>
</head>
<body>
<div class="wrap">

  <h1>지출결의서(지급품의)</h1>

  <div class="header-area">
    <div class="header-left">
      <table class="meta-table">
        <tr><td class="lbl">문서번호</td><td class="doc-no-readonly" style="width:160px;" id="doc-no" data-field="expense-doc-no"></td></tr>
        <tr><td class="lbl">작성일</td><td class="editable" id="doc-date" data-field="expense-doc-date" style="text-align:center;"></td></tr>
        <tr><td class="lbl">작성부서</td><td class="editable" data-field="expense-department">{{COMPANY_NAME}}</td></tr>
        <tr><td class="lbl">작성자</td><td class="editable" data-field="expense-author">{{USER_NAME}}</td></tr>
      </table>
    </div>
    <div class="header-right">
      <table class="approval-table">
        <tr>
          <th rowspan="3">결<br>재<br>인</th>
          <td class="ap-title">대표이사</td>
        </tr>
        <tr><td class="ap-sign editable">{{USER_NAME}}</td></tr>
        <tr><td class="ap-date editable"></td></tr>
      </table>
    </div>
    <div class="clear"></div>
  </div>

  <table class="review-table">
    <tr>
      <td class="lbl">검토의견</td>
      <td class="editable" id="review-opinion" style="height:36px;"></td>
    </tr>
  </table>

  <!-- OCR 버튼 영역 -->
  <div class="ocr-bar no-print">
    <input type="file" id="ocr-file" accept="image/*" multiple style="display:none;" />
    <button id="ocr-btn" onclick="document.getElementById('ocr-file').click()">
      📷 영수증 이미지 인식
    </button>
    <img id="ocr-img-preview" alt="미리보기" />
    <span id="ocr-status"></span>
  </div>

  <!-- 본문 테이블 -->
  <table class="main-table" id="main-table">
    <tr>
      <td style="width:130px; font-weight:bold; text-align:center; background:#d9d9d9;">지급 요청일</td>
      <td colspan="2" class="bg-yellow editable" id="pay-date" style="text-align:center;">비서 정기 결제일</td>
    </tr>
    <tr>
      <th style="width:130px;">거 래 처</th>
      <th>사용내역 및 용도</th>
      <th style="width:150px;">금 액</th>
    </tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr class="data-row"><td class="editable" data-col="vendor"></td><td class="editable" data-col="detail"></td><td class="editable amount" data-col="amount"></td></tr>
    <tr>
      <td colspan="2" class="foot-lbl">합 계</td>
      <td class="bg-pink" id="subtotal"></td>
    </tr>
    <tr>
      <td colspan="2" class="foot-lbl">부가가치세</td>
      <td class="bg-pink editable" id="vat-val"></td>
    </tr>
    <tr>
      <td colspan="2" class="foot-lbl">이 지출 합계</td>
      <td class="bg-pink" id="grand-total"></td>
    </tr>
  </table>

</div>

<div class="no-print" style="text-align:center;margin-top:20px;display:flex;justify-content:center;gap:10px;">
  <button id="save-btn" onclick="var b=document.getElementById('save-btn');b.disabled=true;b.textContent='저장 중...';window.saveExpense();" style="padding:10px 24px;cursor:pointer;border:1px solid #4f46e5;border-radius:4px;background:#4f46e5;color:#fff;font-size:13px;">저장</button>
  <button onclick="alert('지금은 구현되어 있지 않습니다.')" style="padding:10px 24px;cursor:pointer;border:1px solid #aaa;border-radius:4px;background:#fff;font-size:13px;">취소</button>
  <button id="print-btn" onclick="window.printExpense()" style="padding:10px 24px;cursor:pointer;border:1px solid #aaa;border-radius:4px;background:#fff;font-size:13px;">PDF로 저장 / 인쇄하기</button>
  <button onclick="alert('지금은 구현되어 있지 않습니다.')" style="padding:10px 24px;cursor:pointer;border:1px solid #4f46e5;border-radius:4px;background:#4f46e5;color:#fff;font-size:13px;">결재 상신</button>
</div>

<div class="attachment-pages-wrap" id="attachment-pages"></div>

<script>
(function() {
  function parseNum(s) { return parseFloat((s || '0').replace(/[,\\s원\\-]/g, '')) || 0; }
  function fmtNum(n)   { return n ? Math.round(n).toLocaleString('ko-KR') + ' 원' : ''; }

  function recalcTotals() {
    var total = 0;
    document.querySelectorAll('.amount').forEach(function(el) { total += parseNum(el.textContent); });
    var sub = document.getElementById('subtotal');
    var vat = document.getElementById('vat-val');
    var grand = document.getElementById('grand-total');
    if (sub) sub.textContent = fmtNum(total);
    var vatVal = parseNum(vat ? vat.textContent : '0');
    if (grand) grand.textContent = fmtNum(total + vatVal);
  }

  function closePopup() { var p = document.getElementById('_popup'); if (p) p.remove(); }

  function openInput(el) {
    closePopup();
    var isMultiline = el.innerHTML.indexOf('<br>') !== -1;
    var popup = document.createElement('div');
    popup.id = '_popup';
    popup.style.alignItems = isMultiline ? 'flex-start' : 'center';
    var field = isMultiline ? document.createElement('textarea') : document.createElement('input');
    field.value = el.innerText.trim();
    if (!isMultiline) field.style.minWidth = '200px';
    var btn = document.createElement('button');
    btn.textContent = '확인';
    btn.onclick = function() {
      el.textContent = isMultiline ? el.innerHTML = field.value.replace(/\\n/g,'<br>') && '' || field.value : field.value;
      if (!isMultiline) el.textContent = field.value;
      closePopup();
      if (el.classList.contains('amount') || el.id === 'vat-val') recalcTotals();
      var df = el.getAttribute('data-field');
      if (df && (df === 'expense-doc-no' || df === 'expense-doc-date' || df === 'expense-author' || df === 'expense-department')) {
        parent.postMessage({ type: 'templateFieldChanged', field: df, value: field.value }, '*');
      }
    };
    popup.appendChild(field); popup.appendChild(btn);
    document.body.appendChild(popup);
    var rect = el.getBoundingClientRect();
    var top = rect.top - (popup.offsetHeight || 42) - 10;
    if (top < 4) top = rect.bottom + 10;
    popup.style.top = top + 'px';
    popup.style.left = Math.max(4, rect.left) + 'px';
    field.focus(); if (field.select) field.select();
    field.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') btn.onclick();
      if (e.key === 'Escape') closePopup();
    });
    setTimeout(function() {
      document.addEventListener('click', function h(e) {
        if (!popup.contains(e.target) && e.target !== el) { closePopup(); document.removeEventListener('click', h); }
      });
    }, 0);
  }

  // ── 날짜 / 문서번호 초기화 ──────────────────────────────────
  var dn = new Date();
  var days = ['일','월','화','수','목','금','토'];
  var dateStr = dn.getFullYear()+'-'+String(dn.getMonth()+1).padStart(2,'0')+'-'+String(dn.getDate()).padStart(2,'0')+'('+days[dn.getDay()]+')';
  var docDate = document.getElementById('doc-date');
  if (docDate && !docDate.textContent.trim()) {
    docDate.textContent = dateStr;
    parent.postMessage({ type: 'templateFieldChanged', field: 'expense-doc-date', value: dateStr }, '*');
  }
  var docNo = document.getElementById('doc-no');
  if (docNo && !docNo.textContent.trim() && window.EXPENSE_DOC_NO) {
    docNo.textContent = EXPENSE_DOC_NO;
    parent.postMessage({ type: 'templateFieldChanged', field: 'expense-doc-no', value: EXPENSE_DOC_NO }, '*');
  }

  document.querySelectorAll('.editable').forEach(function(el) {
    el.addEventListener('click', function(e) { e.stopPropagation(); openInput(el); });
  });

  // ── 저장된 폼 데이터 복원 ────────────────────────────────────
  if (window.SAVED_FORM_DATA && typeof SAVED_FORM_DATA === 'object') {
    var fd = SAVED_FORM_DATA;
    function setEl(id, val) { var el = document.getElementById(id); if (el && val) el.textContent = val; }
    function setQs(sel, val) { var el = document.querySelector(sel); if (el && val) el.textContent = val; }
    setEl('doc-no',          fd.docNo);
    setEl('doc-date',        fd.docDate);
    setEl('pay-date',        fd.payDate);
    setEl('review-opinion',  fd.reviewOpinion);
    setEl('vat-val',         fd.vat);
    setQs('[data-field="expense-author"]',     fd.author);
    setQs('[data-field="expense-department"]', fd.department);

    // 데이터 행 복원
    if (Array.isArray(fd.rows) && fd.rows.length > 0) {
      var dataRows = document.querySelectorAll('.data-row');
      fd.rows.forEach(function(row, i) {
        if (i >= dataRows.length) return;
        var tr = dataRows[i];
        var v = tr.querySelector('[data-col="vendor"]');
        var d = tr.querySelector('[data-col="detail"]');
        var a = tr.querySelector('[data-col="amount"]');
        if (v) v.textContent = row.vendor || '';
        if (d) d.textContent = row.detail || '';
        if (a) a.textContent = row.amount || '';
      });
      recalcTotals();
    }
  }

  // ── 저장된 첨부 이미지 복원 ─────────────────────────────────
  if (window.SAVED_ATTACHMENTS && SAVED_ATTACHMENTS.length > 0) {
    var attachPages = document.getElementById('attachment-pages');
    SAVED_ATTACHMENTS.forEach(function(att) {
      if (!att.url) return;
      var page = document.createElement('div');
      page.className = 'document-page';
      var img = document.createElement('img');
      img.src = att.url;
      img.alt = att.fileName || '첨부 이미지';
      page.appendChild(img);
      if (attachPages) attachPages.appendChild(page);
    });
  }

  // ── 첫 번째 빈 행 찾기 ─────────────────────────────────────
  function findEmptyRow() {
    var rows = document.querySelectorAll('.data-row');
    for (var i = 0; i < rows.length; i++) {
      var vendor = rows[i].querySelector('[data-col="vendor"]');
      if (vendor && !vendor.textContent.trim()) return rows[i];
    }
    return null;
  }

  // ── 금액 문자열 정제 (- 제거, 숫자+콤마만 남김) ────────────
  function cleanAmount(s) {
    if (!s) return '';
    var n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? '' : Math.round(n).toLocaleString('ko-KR') + ' 원';
  }

  // ── 첨부 이미지 base64 목록 (저장 시 서버로 전송) ──────────────
  var attachmentImages = []; // [{base64, fileName, mimeType}]

  // ── 저장 결과 수신 ───────────────────────────────────────────
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'expenseSaveResult') return;
    var btn = document.getElementById('save-btn');
    if (!btn) return;
    btn.disabled = false;
    if (e.data.success) {
      btn.textContent = '✅ 저장 완료';
      btn.style.background = '#16a34a';
      btn.style.borderColor = '#16a34a';
      setTimeout(function() {
        btn.textContent = '저장';
        btn.style.background = '#4f46e5';
        btn.style.borderColor = '#4f46e5';
      }, 3000);
    } else {
      btn.textContent = '❌ 저장 실패';
      btn.style.background = '#dc2626';
      btn.style.borderColor = '#dc2626';
      setTimeout(function() {
        btn.textContent = '저장';
        btn.style.background = '#4f46e5';
        btn.style.borderColor = '#4f46e5';
      }, 4000);
    }
  });

  // ── 저장 버튼 (전역 노출 — inline onclick에서 접근 필요) ──────
  window.saveExpense = function() {
    var rows = [];
    document.querySelectorAll('.data-row').forEach(function(row) {
      var v = (row.querySelector('[data-col="vendor"]') || {}).textContent.trim() || '';
      var d = (row.querySelector('[data-col="detail"]') || {}).textContent.trim() || '';
      var a = (row.querySelector('[data-col="amount"]') || {}).textContent.trim() || '';
      if (v || d || a) rows.push({ vendor: v, detail: d, amount: a });
    });
    var data = {
      docNo:          (document.getElementById('doc-no') || {}).textContent.trim() || '',
      docDate:        (document.getElementById('doc-date') || {}).textContent.trim() || '',
      author:         (document.querySelector('[data-field="expense-author"]') || {}).textContent.trim() || '',
      department:     (document.querySelector('[data-field="expense-department"]') || {}).textContent.trim() || '',
      payDate:        (document.getElementById('pay-date') || {}).textContent.trim() || '',
      reviewOpinion:  (document.getElementById('review-opinion') || {}).textContent.trim() || '',
      rows:           rows,
      subtotal:       (document.getElementById('subtotal') || {}).textContent.trim() || '',
      vat:            (document.getElementById('vat-val') || {}).textContent.trim() || '',
      grandTotal:     (document.getElementById('grand-total') || {}).textContent.trim() || '',
      attachments:    attachmentImages,
    };
    parent.postMessage({ type: 'expenseSave', data: data }, '*');
  }

  // ── 인쇄 버튼 (지출결의서 전용) ───────────────────────────────
  // 첨부 이미지 로딩을 짧게 대기한 뒤 인쇄해서 누락 가능성을 줄인다.
  window.printExpense = function() {
    closePopup();
    var btn = document.getElementById('print-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '인쇄 준비 중...';
    }

    function runPrint() {
      setTimeout(function() {
        // 앱 전체가 아닌 지출결의서 문서 본문만 별도 창에서 인쇄
        var wrapEl = document.querySelector('.wrap');
        var attachmentEl = document.getElementById('attachment-pages');
        var styleEl = document.querySelector('style');
        if (!wrapEl || !styleEl) {
          window.print();
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'PDF로 저장 / 인쇄하기';
          }
          return;
        }

        var printWindow = window.open('', '_blank');
        if (!printWindow) {
          window.print();
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'PDF로 저장 / 인쇄하기';
          }
          return;
        }

        var printableHtml = '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>지출결의서 인쇄</title>'
          + styleEl.outerHTML
          + '</head><body>'
          + wrapEl.outerHTML
          + (attachmentEl ? attachmentEl.outerHTML : '')
          + '</body></html>';

        printWindow.document.open();
        printWindow.document.write(printableHtml);
        printWindow.document.close();
        printWindow.focus();

        setTimeout(function() {
          printWindow.print();
          printWindow.close();
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'PDF로 저장 / 인쇄하기';
          }
        }, 120);
      }, 40);
    }

    var waitImgs = Array.from(document.querySelectorAll('.attachment-pages-wrap img'))
      .filter(function(img) { return !img.complete; });

    if (waitImgs.length === 0) {
      runPrint();
      return;
    }

    var remain = waitImgs.length;
    waitImgs.forEach(function(img) {
      function done() {
        remain -= 1;
        if (remain <= 0) runPrint();
      }
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });

    // 네트워크 상태가 느릴 때도 인쇄 동작이 막히지 않게 타임아웃 보장
    setTimeout(function() {
      if (remain > 0) runPrint();
    }, 1800);
  }

  // ── OCR: 이미지 → Ollama gemma4:e4b 호출 ───────────────────
  var ocrFile  = document.getElementById('ocr-file');
  var ocrBtn   = document.getElementById('ocr-btn');
  var ocrStatus = document.getElementById('ocr-status');
  var ocrPreview = document.getElementById('ocr-img-preview');

  ocrFile.addEventListener('change', function() {
    var files = Array.from(ocrFile.files);
    if (!files.length) return;
    ocrFile.value = '';

    // 파일을 순서대로 처리 (OCR이 겹치지 않도록 순차 실행)
    ocrBtn.disabled = true;
    var chain = Promise.resolve();
    files.forEach(function(file, idx) {
      chain = chain.then(function() {
        return processOneFile(file, idx + 1, files.length);
      });
    });
    chain.finally(function() {
      ocrBtn.disabled = false;
      setTimeout(function() { setStatus(''); }, 3000);
    });
  });

  function setStatus(msg, color) {
    ocrStatus.textContent = msg;
    ocrStatus.style.color = color || '#6b7280';
  }

  // 이미지 한 장 처리: 첨부 페이지 추가 + OCR
  function processOneFile(file, current, total) {
    return new Promise(function(resolve) {
      var previewUrl = URL.createObjectURL(file);

      // 마지막 파일만 상단 미리보기에 표시
      ocrPreview.src = previewUrl;
      ocrPreview.style.display = 'inline-block';

      // 첨부 이미지 페이지 추가 (인쇄용 A4 사각형)
      var attachPages = document.getElementById('attachment-pages');
      if (attachPages) {
        var page = document.createElement('div');
        page.className = 'document-page';
        var pageImg = document.createElement('img');
        pageImg.src = previewUrl;
        page.appendChild(pageImg);
        attachPages.appendChild(page);
      }

      // base64 변환 후 OCR + 저장용 배열에 추가
      var reader = new FileReader();
      reader.onload = function(ev) {
        var base64 = ev.target.result.split(',')[1];
        attachmentImages.push({ base64: base64, fileName: file.name, mimeType: file.type || 'image/jpeg' });
        runOCR(base64, current, total).then(resolve).catch(resolve); // 실패해도 다음 파일 진행
      };
      reader.readAsDataURL(file);
    });
  }

  function runOCR(base64, current, total) {
    var label = total > 1 ? ' (' + current + '/' + total + ')' : '';
    setStatus('⏳ AI가 이미지를 분석 중입니다...' + label, '#4f46e5');

    var prompt = '이 영수증 또는 카드 명세서 이미지를 분석하세요.\\n' +
      '다음 JSON 형식으로만 응답하세요 (설명 없이 JSON만):' +
      '{"상호":"상호명","사용내역":"구매내용 요약","금액":"숫자만(콤마포함, 기호없음)"}\\n' +
      '금액에서 - 기호는 반드시 제거하세요.';

    return fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma4:e4b',
        messages: [{ role: 'user', content: prompt, images: [base64] }],
        stream: false,
        options: { temperature: 0.1 }
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var text = (data.message && data.message.content) || '';
      var match = text.match(/\\{[^}]+\\}/);
      if (!match) throw new Error('JSON 파싱 실패: ' + text);
      var parsed = JSON.parse(match[0]);

      var row = findEmptyRow();
      if (!row) { setStatus('⚠️ 빈 행이 없습니다.' + label, '#f59e0b'); return; }

      var vendorEl = row.querySelector('[data-col="vendor"]');
      var detailEl = row.querySelector('[data-col="detail"]');
      var amountEl = row.querySelector('[data-col="amount"]');

      if (vendorEl && parsed['상호'])      vendorEl.textContent = parsed['상호'].trim();
      if (detailEl && parsed['사용내역']) detailEl.textContent = parsed['사용내역'].trim();
      if (amountEl && parsed['금액'])     amountEl.textContent = cleanAmount(parsed['금액']);

      recalcTotals();
      setStatus('✅ 인식 완료!' + label, '#16a34a');
    })
    .catch(function(err) {
      setStatus('❌ 인식 실패' + label + ': ' + err.message, '#dc2626');
    });
  }
})();
</script>
</body>
</html>`,
  },
  {
    id: 'md-page',
    label: 'MD 페이지',
    icon: '📝',
    content: '<!--md-page-->\n# 새 Markdown 페이지\n\n이 곳에 내용을 입력하세요.\n',
  },
]

export function isTemplateContent(content) {
  return typeof content === 'string' && content.trimStart().startsWith('<!DOCTYPE html>')
}

export function isMdPage(content) {
  return typeof content === 'string' && content.trimStart().startsWith('<!--md-page-->')
}

export function getMdPageContent(content) {
  if (!content) return ''
  return content.replace(/^<!--md-page-->\n?/, '')
}
