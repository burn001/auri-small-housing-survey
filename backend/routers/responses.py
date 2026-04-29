import logging
from fastapi import APIRouter, Request, HTTPException
from datetime import datetime, timezone
import re
import uuid
from models import ResponseSubmit, ResponseRecord, ParticipantUpdate, SelfRegisterRequest, RecoverRequest
from services.db import get_db
from services.email_service import render_completion, render_email, send_email, send_email_multi
from config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["responses"])

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

# 사례품 정원 기반 단일 캡 — 도달 시 신규 자가등록·신규 제출·미응답자 토큰 진입 모두 410 차단.
# 직원 테스트(source=staff)는 카운트와 검사 모두에서 자동 제외. 이미 제출한 응답자의 본인
# 응답 확인(review)·수정은 마감 후에도 허용 (UX 우선).
SURVEY_LIMIT = 300


async def _get_completed_count(db) -> int:
    """정원 카운트 — 직원 테스트(source=staff)와 내부 연구진(category=연구진)을 제외한
    submitted 응답 수. 사전등록·자가등록 합산.
    """
    excluded_tokens = [
        p["token"]
        async for p in db.participants.find(
            {"$or": [{"source": "staff"}, {"category": "연구진"}]},
            {"token": 1, "_id": 0},
        )
    ]
    return await db.responses.count_documents({
        "submitted_at": {"$ne": None},
        "token": {"$nin": excluded_tokens},
    })


async def _is_survey_closed(db) -> bool:
    return (await _get_completed_count(db)) >= SURVEY_LIMIT


# 50부 단위 마일스톤 보고 메일 — 연구진(이주경 부연구위원)에게 진행 현황 통보.
# TODO: 이화영 연구원 이메일 확인 후 MILESTONE_TO에 추가
MILESTONES = [50, 100, 150, 200, 250, 300]
MILESTONE_TO = ["jklee@auri.re.kr"]
MILESTONE_CC = ["blaster@auri.re.kr"]


async def _gather_milestone_stats(db) -> dict:
    """카테고리별 응답 수, 사례품 동의자 수 (연구진·staff 제외)."""
    pipeline_cat = [
        {"$match": {"submitted_at": {"$ne": None}}},
        {"$lookup": {
            "from": "participants",
            "localField": "token",
            "foreignField": "token",
            "as": "p",
        }},
        {"$unwind": "$p"},
        {"$match": {"p.category": {"$ne": "연구진"}, "p.source": {"$ne": "staff"}}},
        {"$group": {"_id": "$p.category", "count": {"$sum": 1}}},
    ]
    by_cat = {}
    async for doc in db.responses.aggregate(pipeline_cat):
        by_cat[doc["_id"] or "(미분류)"] = doc["count"]

    pipeline_reward = [
        {"$match": {"submitted_at": {"$ne": None}}},
        {"$lookup": {
            "from": "participants",
            "localField": "token",
            "foreignField": "token",
            "as": "p",
        }},
        {"$unwind": "$p"},
        {"$match": {
            "p.category": {"$ne": "연구진"},
            "p.source": {"$ne": "staff"},
            "p.consent_reward": True,
        }},
        {"$count": "n"},
    ]
    reward = 0
    async for doc in db.responses.aggregate(pipeline_reward):
        reward = doc["n"]

    return {"by_category": by_cat, "reward_consenters": reward}


def _render_milestone_html(milestone: int, completed: int, stats: dict, admin_url: str) -> str:
    pct = round(completed / SURVEY_LIMIT * 100, 1)
    cat_rows = "".join(
        f'<tr><td style="color:#666">{cat}</td>'
        f'<td align="right"><strong>{cnt}</strong>명</td></tr>'
        for cat, cnt in sorted(stats["by_category"].items(), key=lambda x: -x[1])
    ) or '<tr><td colspan="2" style="color:#999">집계 없음</td></tr>'

    closing_block = ""
    if milestone >= SURVEY_LIMIT:
        closing_block = (
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">'
            '<tr><td style="background:#fff4e6;border-left:4px solid #d97706;padding:18px 22px;border-radius:6px;font-size:13px;color:#5b3a14;line-height:1.8">'
            '<strong>📌 응답 모집 마감</strong><br>'
            f'목표 {SURVEY_LIMIT}부에 도달하여 신규 응답 접수가 자동 차단되었습니다. '
            '신규 진입·이어작성 모두 마감 안내 화면으로 전환됩니다 (이미 제출한 응답자의 본인 확인·수정은 허용).'
            '</td></tr></table>'
        )
    return f"""
    <div style="font-family:'Noto Sans KR',sans-serif;font-size:14px;line-height:1.7;color:#222;max-width:640px;margin:0 auto;padding:24px">
      <h2 style="font-size:18px;margin:0 0 8px">소규모 주거 전문가 설문 응답 {milestone}부 도달 안내</h2>
      <p style="color:#666;font-size:13px;margin:0 0 24px">자동 발송 — AURI 소규모(비아파트) 주거 전문가 설문 시스템</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
        <tr><td style="background:#f0f4f8;border-left:4px solid #2c2c2c;padding:18px 22px;border-radius:6px">
          <strong style="font-size:15px">유효 완료 응답: {completed}부 / {SURVEY_LIMIT}부 ({pct}%)</strong>
          <div style="color:#666;font-size:12px;margin-top:6px">연구진(category=연구진) · 직원 테스트(source=staff) 제외</div>
        </td></tr>
      </table>

      {closing_block}

      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:6px;margin:0 0 24px">
        <tr><td style="padding:18px 22px">
          <strong style="display:block;margin:0 0 12px;font-size:14px">소속 분야별 응답 현황</strong>
          <table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px">
            {cat_rows}
            <tr><td style="color:#666;border-top:1px solid #eee;padding-top:10px">사례품 동의 응답자</td>
                <td align="right" style="border-top:1px solid #eee;padding-top:10px"><strong>{stats['reward_consenters']}</strong>명</td></tr>
          </table>
        </td></tr>
      </table>

      <p style="font-size:13px;color:#444;line-height:1.8;margin:0 0 16px">
        상세 내역은 <a href="{admin_url}" style="color:#2c2c2c">관리자 페이지</a>에서 확인하실 수 있습니다.
      </p>

      <p style="font-size:12px;color:#999;margin:0">
        ― AURI 소규모 주거 전문가 설문 시스템 (자동 발송 · 회신 불가)
      </p>
    </div>
    """


async def _send_milestone_emails_if_needed(db) -> None:
    """제출 후 호출. 50/100/150/200/250/300 마일스톤 도달 + 미발송이면 자동 발송.
    이미 발송된 마일스톤은 email_logs(type=milestone, status=sent)로 식별하여 스킵.
    실패해도 응답 처리는 영향받지 않음."""
    s = get_settings()
    if not s.GMAIL_USER or not s.GMAIL_APP_PASSWORD:
        return

    completed = await _get_completed_count(db)

    pending = []
    for m in MILESTONES:
        if completed < m:
            break
        already = await db.email_logs.find_one(
            {"type": "milestone", "milestone": m, "status": "sent"}
        )
        if not already:
            pending.append(m)

    if not pending:
        return

    stats = await _gather_milestone_stats(db)
    admin_url = f"{(s.SURVEY_BASE_URL or '').rstrip('/')}/admin/"

    for m in pending:
        subject = f"[AURI 소규모 주거 전문가 설문] 응답 {m}부 도달 — 진행 현황 보고"
        log_doc = {
            "type": "milestone",
            "milestone": m,
            "completed_at_send": completed,
            "to": MILESTONE_TO,
            "cc": MILESTONE_CC,
            "subject": subject,
            "admin_email": "system",
            "admin_name": "마일스톤 자동 발송",
            "sent_at": datetime.now(timezone.utc),
        }
        try:
            html = _render_milestone_html(m, completed, stats, admin_url)
            send_email_multi(MILESTONE_TO, MILESTONE_CC, subject=subject, html_body=html)
            log_doc.update({"status": "sent", "error": ""})
            await db.email_logs.insert_one(log_doc)
        except Exception as e:
            err = str(e)
            logger.warning(f"Milestone {m}부 send failed: {err}")
            log_doc.update({"status": "failed", "error": err})
            try:
                await db.email_logs.insert_one(log_doc)
            except Exception:
                pass


async def _send_completion_email(participant: dict, token: str) -> None:
    """응답 제출 직후 자동 발송. 실패해도 응답 처리는 영향받지 않음.
    email_logs에 type=completion으로 기록하여 발송 이력에 함께 노출된다.
    """
    s = get_settings()
    if not s.GMAIL_USER or not s.GMAIL_APP_PASSWORD:
        return
    if not participant.get("email"):
        return
    db = get_db()
    base = (s.SURVEY_BASE_URL or "").rstrip("/")
    review_url = f"{base}/?token={token}"
    subject = "[AURI 소규모 주거 전문가 설문] 응답 완료 안내 — 내 응답 확인 링크"
    html = render_completion(
        participant.get("name", ""),
        participant.get("org", ""),
        review_url,
    )
    now = datetime.now(timezone.utc)
    log_doc = {
        "batch_id": "auto-completion",
        "token": token,
        "email": participant["email"],
        "name": participant.get("name", ""),
        "org": participant.get("org", ""),
        "category": participant.get("category", ""),
        "type": "completion",
        "subject": subject,
        "admin_email": "system",
        "admin_name": "자동 발송",
        "sent_at": now,
    }
    try:
        send_email(participant["email"], subject, html)
        log_doc.update({"status": "sent", "error": ""})
        await db.email_logs.insert_one(log_doc)
    except Exception as e:
        err = str(e)
        logger.warning(f"Completion email failed for {participant['email']}: {err}")
        log_doc.update({"status": "failed", "error": err})
        try:
            await db.email_logs.insert_one(log_doc)
        except Exception:
            pass


@router.get("/survey/status")
async def survey_status():
    """공개 — 설문 진행 상황 (마감 여부·완료 수·limit). 마감 화면용.
    직원 테스트(source=staff) 응답은 분모·분자 모두 제외된다.
    """
    db = get_db()
    completed = await _get_completed_count(db)
    return {
        "completed": completed,
        "limit": SURVEY_LIMIT,
        "is_closed": completed >= SURVEY_LIMIT,
    }


@router.get("/survey/{token}")
async def verify_token(token: str):
    db = get_db()
    participant = await db.participants.find_one({"token": token}, {"_id": 0})
    if not participant:
        raise HTTPException(404, "유효하지 않은 설문 링크입니다.")

    existing = await db.responses.find_one({"token": token}, {"_id": 0})

    # 마감 후에는 미응답자의 신규 진입·이어작성을 차단 (이미 제출한 응답자의 review·수정은 허용).
    # 직원 테스트(source=staff) 토큰은 마감 검사 자체를 건너뜀.
    if (
        participant.get("source") != "staff"
        and not existing
        and await _is_survey_closed(db)
    ):
        raise HTTPException(
            410,
            f"설문이 마감되었습니다. (목표 {SURVEY_LIMIT}부 도달) 참여해 주셔서 감사합니다.",
        )
    return {
        "token": participant["token"],
        "name": participant.get("name", ""),
        "email": participant.get("email", ""),
        "org": participant.get("org", ""),
        "category": participant.get("category", ""),
        "field": participant.get("field", ""),
        "phone": participant.get("phone", ""),
        "source": participant.get("source", "imported"),
        "consent_pi": bool(participant.get("consent_pi", False)),
        "consent_reward": bool(participant.get("consent_reward", False)),
        "reward_phone": participant.get("reward_phone", ""),
        "has_responded": existing is not None,
        "responses": existing.get("responses") if existing else None,
        "submitted_at": existing.get("submitted_at").isoformat() if existing and existing.get("submitted_at") else None,
        "updated_at": existing.get("updated_at").isoformat() if existing and existing.get("updated_at") else None,
    }


@router.patch("/survey/{token}/participant")
async def update_participant(token: str, body: ParticipantUpdate, request: Request):
    db = get_db()
    current = await db.participants.find_one({"token": token})
    if not current:
        raise HTTPException(404, "유효하지 않은 토큰입니다.")

    update_fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not update_fields:
        raise HTTPException(400, "수정할 필드가 없습니다.")

    if "email" in update_fields and update_fields["email"] != current.get("email"):
        clash = await db.participants.find_one({
            "email": update_fields["email"],
            "token": {"$ne": token},
        })
        if clash:
            raise HTTPException(409, "이미 사용 중인 이메일입니다.")

    now = datetime.utcnow()
    last_backup = await db.participants_backup.find_one(
        {"token": token}, sort=[("version", -1)]
    )
    next_version = (last_backup.get("version", 0) + 1) if last_backup else 1

    snapshot = {k: v for k, v in current.items() if k != "_id"}
    await db.participants_backup.insert_one({
        "token": token,
        "version": next_version,
        "backed_up_at": now,
        "ip": request.client.host if request.client else "",
        "user_agent": request.headers.get("user-agent", ""),
        "snapshot": snapshot,
    })

    update_fields["updated_at"] = now
    await db.participants.update_one({"token": token}, {"$set": update_fields})

    updated = await db.participants.find_one({"token": token}, {"_id": 0})
    return {
        "status": "updated",
        "backup_version": next_version,
        "participant": {
            "token": updated["token"],
            "name": updated.get("name", ""),
            "email": updated.get("email", ""),
            "org": updated.get("org", ""),
            "phone": updated.get("phone", ""),
            "category": updated.get("category", ""),
        },
    }


@router.post("/responses")
async def submit_response(body: ResponseSubmit, request: Request):
    db = get_db()
    participant = await db.participants.find_one({"token": body.token})
    if not participant:
        raise HTTPException(404, "유효하지 않은 토큰입니다.")

    now = datetime.utcnow()
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    # 사례품 동의·휴대폰은 participants 문서에 별도 저장 (응답 데이터와 분리)
    if body.consent_reward is not None:
        participant_update: dict = {
            "consent_reward": bool(body.consent_reward),
            "consent_reward_at": now if body.consent_reward else None,
        }
        if body.consent_reward:
            participant_update["reward_phone"] = (body.reward_phone or "").strip()
            participant_update["reward_name"] = participant.get("name", "")
        else:
            # 거부 시 기존 reward 정보 비움
            participant_update["reward_phone"] = ""
            participant_update["reward_name"] = ""
        await db.participants.update_one(
            {"token": body.token},
            {"$set": participant_update},
        )

    existing = await db.responses.find_one({"token": body.token})
    if existing:
        await db.responses.update_one(
            {"token": body.token},
            {"$set": {
                "responses": body.responses,
                "survey_version": body.survey_version,
                "updated_at": now,
                "ip": ip,
                "user_agent": ua,
            }},
        )
        # 수정 제출 시에는 완료 메일을 다시 보내지 않는다 (스팸 방지). 최초 제출 시점에 1회만 발송.
        return {"status": "updated", "token": body.token}

    # 신규(최초) 제출은 마감 시 차단. 이미 제출한 응답자의 수정은 위 분기에서 통과되므로 영향 없음.
    # 직원 테스트(source=staff)는 정원 검사 건너뜀.
    if participant.get("source") != "staff" and await _is_survey_closed(db):
        raise HTTPException(
            410,
            f"설문이 마감되었습니다. (목표 {SURVEY_LIMIT}부 도달) 참여해 주셔서 감사합니다.",
        )

    record = ResponseRecord(
        token=body.token,
        survey_version=body.survey_version,
        responses=body.responses,
        submitted_at=now,
        ip=ip,
        user_agent=ua,
    )
    await db.responses.insert_one(record.model_dump())
    # 최초 제출 — 응답자에게 완료 안내 메일 자동 발송 (실패해도 응답은 정상 저장됨)
    # 이때 participants 문서에는 위에서 reward 정보 갱신이 반영되었을 수 있으므로 재조회한다.
    refreshed = await db.participants.find_one({"token": body.token}) or participant
    await _send_completion_email(refreshed, body.token)
    # 50부 단위 마일스톤 보고 메일 — _get_completed_count가 staff/연구진 제외하므로 안전하게 호출.
    await _send_milestone_emails_if_needed(db)
    return {"status": "created", "token": body.token}


# ── 공개 자가등록 (No Auth) ──
@router.post("/survey/register")
async def self_register(body: SelfRegisterRequest, request: Request):
    """공개 링크에서 응답자가 직접 정보를 입력하고 토큰을 발급받는다.

    분기:
    - 신규 email: 새 토큰 발급.
    - imported 명단 & 미응답: 폼 입력값으로 정보 갱신 + source 전환 + 기존 토큰 노출(smooth 진입).
      신원 사칭 방지를 위해 폼 입력값이 imported 정보를 덮어씀. 정원 검사는 건너뜀.
    - 이미 응답 완료: 차단 (재등록 의미 없음, /recover로 리뷰 링크).
    - 이미 self/staff 등록: 차단 (분실 시 /recover).
    """
    email = (body.email or "").strip().lower()
    name = (body.name or "").strip()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "올바른 이메일을 입력해 주십시오.")
    if not name:
        raise HTTPException(400, "이름을 입력해 주십시오.")
    if not body.consent_pi:
        raise HTTPException(400, "개인정보 수집·이용에 동의해 주셔야 참여하실 수 있습니다.")

    db = get_db()
    existing = await db.participants.find_one({"email": email})

    # 응답 완료자·self/staff 기등록자는 차단 — 분실 시 /recover.
    # 응답 완료 여부는 participants에 필드가 없으므로 responses 컬렉션을 직접 조회.
    if existing:
        existing_resp = await db.responses.find_one(
            {"token": existing["token"], "submitted_at": {"$ne": None}},
            {"_id": 1},
        )
        if existing_resp:
            raise HTTPException(
                409,
                "이 이메일로 이미 응답을 제출하셨습니다. 응답 확인·수정은 '토큰 재발송'을 요청해 메일의 리뷰 링크로 접속해 주십시오.",
            )
        if existing.get("source") in ("self", "staff"):
            raise HTTPException(
                409,
                "이 이메일로 이미 등록되어 있습니다. 처음 등록 시 받으신 메일의 링크로 접속하시거나, 메일을 못 받으셨다면 '토큰 재발송'을 요청해 주십시오.",
            )

    # 직원 테스트(is_staff=true) + imported promote는 정원 검사를 건너뜀.
    if not body.is_staff and not existing and await _is_survey_closed(db):
        raise HTTPException(
            410,
            f"설문이 마감되었습니다. (목표 {SURVEY_LIMIT}부 도달) 참여해 주셔서 감사합니다.",
        )

    now = datetime.utcnow()
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    # imported 명단 & 미응답 → 폼 입력값으로 정보 갱신 후 기존 토큰 노출 (smooth 진입).
    if existing:
        token = existing["token"]
        last_backup = await db.participants_backup.find_one(
            {"token": token}, sort=[("version", -1)]
        )
        next_version = (last_backup.get("version", 0) + 1) if last_backup else 1
        snapshot = {k: v for k, v in existing.items() if k != "_id"}
        await db.participants_backup.insert_one({
            "token": token,
            "version": next_version,
            "backed_up_at": now,
            "ip": ip,
            "user_agent": ua,
            "snapshot": snapshot,
            "source_action": "self_register_promote",
        })

        update_fields = {
            "name": name,
            "org": (body.org or "").strip(),
            "category": (body.category or "").strip(),
            "source": "staff" if body.is_staff else "self",
            "consent_pi": True,
            "consent_pi_at": now,
            "register_ip": ip,
            "register_ua": ua,
            "register_updated_at": now,
            "self_registered_at": now,
            "updated_at": now,
        }
        await db.participants.update_one({"token": token}, {"$set": update_fields})

        return {
            "status": "promoted",
            "token": token,
        }

    token = uuid.uuid4().hex[:16]

    doc = {
        "token": token,
        "email": email,
        "name": name,
        "org": (body.org or "").strip(),
        "category": (body.category or "").strip(),
        "field": "",
        "phone": "",
        "source": "staff" if body.is_staff else "self",
        "consent_pi": True,
        "consent_pi_at": now,
        "register_ip": ip,
        "register_ua": ua,
        "register_updated_at": now,
        "created_at": now,
    }
    await db.participants.insert_one(doc)

    return {
        "status": "created",
        "token": token,
    }


@router.post("/survey/recover")
async def recover_token(body: RecoverRequest):
    """자가등록자가 토큰 링크를 분실한 경우, 등록 시 사용한 email로 토큰 링크를 재발송한다.

    - 응답에는 토큰을 노출하지 않는다 (메일 수신만이 본인 확인 메커니즘).
    - 등록 여부와 무관하게 동일한 응답을 반환해 email 정찰을 어렵게 한다.
    - 응답 미제출이면 '설문 시작 링크', 제출 완료면 '응답 확인·수정 링크'를 발송한다.
    """
    s = get_settings()
    email = (body.email or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "올바른 이메일을 입력해 주십시오.")

    db = get_db()
    participant = await db.participants.find_one({"email": email}, {"_id": 0})
    if not participant:
        return {"status": "sent"}

    token = participant["token"]
    name = participant.get("name") or "응답자"
    org = participant.get("org", "")

    existing_resp = await db.responses.find_one({"token": token}, {"submitted_at": 1})
    has_submitted = bool(existing_resp and existing_resp.get("submitted_at"))

    base = (s.SURVEY_BASE_URL or "").rstrip("/")
    link_url = f"{base}/?token={token}"
    if has_submitted:
        subject = "[AURI 소규모 주거 전문가 설문] 응답 확인·수정 링크 재발송"
        html = render_completion(name, org, link_url)
    else:
        subject = "[AURI 소규모 주거 전문가 설문] 설문 참여 링크 재발송"
        html = render_email(name, org, link_url)

    log_doc = {
        "batch_id": "auto-recovery",
        "token": token,
        "email": email,
        "name": participant.get("name", ""),
        "org": org,
        "category": participant.get("category", ""),
        "type": "recovery",
        "subject": subject,
        "admin_email": "system",
        "admin_name": "자동 재발송",
        "sent_at": datetime.utcnow(),
    }
    try:
        send_email(email, subject, html)
        log_doc.update({"status": "sent", "error": ""})
    except Exception as e:
        err = str(e)
        logger.warning(f"Recovery email failed for {email}: {err}")
        log_doc.update({"status": "failed", "error": err})
    try:
        await db.email_logs.insert_one(log_doc)
    except Exception:
        pass

    return {"status": "sent"}


@router.get("/responses/{token}")
async def get_response(token: str):
    db = get_db()
    doc = await db.responses.find_one({"token": token}, {"_id": 0})
    if not doc:
        return {"token": token, "responses": None}
    return doc
