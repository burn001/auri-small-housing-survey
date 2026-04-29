import logging
from fastapi import APIRouter, Request, HTTPException
from datetime import datetime, timezone
import re
import uuid
from models import ResponseSubmit, ResponseRecord, ParticipantUpdate, SelfRegisterRequest
from services.db import get_db
from services.email_service import render_completion, send_email
from config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["responses"])

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


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


@router.get("/survey/{token}")
async def verify_token(token: str):
    db = get_db()
    participant = await db.participants.find_one({"token": token}, {"_id": 0})
    if not participant:
        raise HTTPException(404, "유효하지 않은 설문 링크입니다.")

    existing = await db.responses.find_one({"token": token}, {"_id": 0})
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
    return {"status": "created", "token": body.token}


# ── 공개 자가등록 (No Auth) ──
@router.post("/survey/register")
async def self_register(body: SelfRegisterRequest, request: Request):
    """공개 링크에서 응답자가 직접 정보를 입력하고 토큰을 발급받는다.

    이메일 dedup: 동일 이메일이 imported 또는 self로 이미 등록되어 있으면
    그 토큰을 그대로 반환하고, 응답 완료 여부(has_responded)를 함께 응답한다.
    클라이언트는 has_responded=true이면 '이미 응답하셨습니다' 안내 화면을 띄우고,
    false이면 토큰 URL로 진입시켜 설문을 이어 작성하도록 한다.
    """
    email = (body.email or "").strip().lower()
    name = (body.name or "").strip()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "올바른 이메일을 입력해 주십시오.")
    if not name:
        raise HTTPException(400, "이름을 입력해 주십시오.")
    if not body.consent_pi:
        raise HTTPException(400, "개인정보 수집·이용에 동의해 주셔야 참여하실 수 있습니다.")

    now = datetime.utcnow()
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    db = get_db()
    existing = await db.participants.find_one({"email": email})

    base_fields = {
        "email": email,
        "name": name,
        "org": (body.org or "").strip(),
        "category": (body.category or "").strip(),
        "consent_pi": True,
        "consent_pi_at": now,
        "register_ip": ip,
        "register_ua": ua,
        "register_updated_at": now,
    }

    if existing:
        token = existing["token"]
        # 기존 등록자의 source는 보존 (첫 진입 채널 유지). imported였던 응답자가
        # 자가등록 페이지로 들어와도 imported로 남는다. 단 직원 테스트 모드는 동일 이메일로
        # 다시 진입했더라도 staff로 승격(분석에서 제외되도록).
        existing_source = existing.get("source", "imported")
        base_fields["source"] = "staff" if body.is_staff else existing_source
        await db.participants.update_one({"token": token}, {"$set": base_fields})
        status = "updated"
    else:
        token = uuid.uuid4().hex[:16]
        base_fields.update({
            "token": token,
            "source": "staff" if body.is_staff else "self",
            "field": "",
            "phone": "",
            "created_at": now,
        })
        await db.participants.insert_one(base_fields)
        status = "created"

    has_responded = (await db.responses.find_one({"token": token}, {"_id": 1})) is not None

    return {
        "status": status,
        "token": token,
        "has_responded": has_responded,
    }


@router.get("/responses/{token}")
async def get_response(token: str):
    db = get_db()
    doc = await db.responses.find_one({"token": token}, {"_id": 0})
    if not doc:
        return {"token": token, "responses": None}
    return doc
