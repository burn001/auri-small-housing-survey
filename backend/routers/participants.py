from fastapi import APIRouter, HTTPException, Header
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone
from uuid import uuid4
from services.db import get_db
from services.email_service import (
    render_email, render_custom, send_email,
    email_subject_for, _normalize_survey_url,
)
from config import get_settings
import logging

logger = logging.getLogger(__name__)

ALLOWED_EMAIL_TYPES = {"invite", "reminder", "deadline", "custom"}

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _check_admin(key: Optional[str]) -> dict:
    if key != get_settings().ADMIN_KEY:
        raise HTTPException(403, "관리자 인증 실패")
    return {"name": "관리자", "email": "admin@auri.re.kr", "role": "owner", "token": key}


@router.get("/me")
async def whoami(x_admin_key: Optional[str] = Header(None)):
    return _check_admin(x_admin_key)


@router.get("/stats")
async def get_stats(
    x_admin_key: Optional[str] = Header(None),
    include_staff: bool = False,
    include_reviewer: bool = False,
):
    """대시보드 통계.
    기본은 직원 테스트(source=staff) + 내부 연구진(category=연구진) 모두 제외 — 분석 의미가 있는 수치.
    include_staff·include_reviewer 플래그로 각각 포함시켜 보고 싶을 때 사용.
    by_category에는 연구진/staff 모두 그대로 노출 (분포 정보).
    """
    _check_admin(x_admin_key)
    db = get_db()

    # 분석 대상에서 제외할 token 집합 — 카운트·응답률 계산에서 빠져야 하는 응답자.
    exclude_or = []
    if not include_staff:
        exclude_or.append({"source": "staff"})
    if not include_reviewer:
        exclude_or.append({"category": "연구진"})
    if exclude_or:
        excluded_tokens = [
            d["token"]
            async for d in db.participants.find(
                {"$or": exclude_or}, {"token": 1, "_id": 0}
            )
        ]
        token_filter = {"token": {"$nin": excluded_tokens}}
        # participants는 source/category 기준으로 직접 필터
        participant_filter = {"$nor": exclude_or}
    else:
        token_filter = {}
        participant_filter = {}

    total_p = await db.participants.count_documents(participant_filter)
    total_r = await db.responses.count_documents(token_filter)

    # 별도 카운트 — 대시보드 카드에 분리 표시
    staff_p = await db.participants.count_documents({"source": "staff"})
    staff_tokens = [
        d["token"]
        async for d in db.participants.find({"source": "staff"}, {"token": 1, "_id": 0})
    ]
    staff_r = await db.responses.count_documents(
        {"token": {"$in": staff_tokens}} if staff_tokens else {"token": {"$in": []}}
    )

    reviewer_p = await db.participants.count_documents({"category": "연구진"})
    reviewer_tokens = [
        d["token"]
        async for d in db.participants.find({"category": "연구진"}, {"token": 1, "_id": 0})
    ]
    reviewer_r = await db.responses.count_documents(
        {"token": {"$in": reviewer_tokens}} if reviewer_tokens else {"token": {"$in": []}}
    )

    # 카테고리별 분포는 모든 응답자(staff·연구진 포함) 그대로 보여 준다 — 분포 정보이므로.
    pipeline = [
        {"$lookup": {
            "from": "responses",
            "localField": "token",
            "foreignField": "token",
            "as": "resp",
        }},
        {"$group": {
            "_id": "$category",
            "participants": {"$sum": 1},
            "responded": {"$sum": {"$cond": [{"$gt": [{"$size": "$resp"}, 0]}, 1, 0]}},
        }},
        {"$sort": {"_id": 1}},
    ]
    cursor = db.participants.aggregate(pipeline)
    by_category = {}
    async for doc in cursor:
        cat = doc["_id"] or "미분류"
        by_category[cat] = {
            "participants": doc["participants"],
            "responded": doc["responded"],
        }

    return {
        "total_participants": total_p,
        "total_responses": total_r,
        "by_category": by_category,
        "staff_participants": staff_p,
        "staff_responses": staff_r,
        "staff_excluded": not include_staff,
        "reviewer_participants": reviewer_p,
        "reviewer_responses": reviewer_r,
        "reviewer_excluded": not include_reviewer,
    }


@router.get("/responses")
async def list_responses(
    x_admin_key: Optional[str] = Header(None),
    skip: int = 0,
    limit: int = 200,
    category: Optional[str] = None,
    source: Optional[str] = None,
):
    _check_admin(x_admin_key)
    db = get_db()

    pipeline = [
        {"$lookup": {
            "from": "participants",
            "localField": "token",
            "foreignField": "token",
            "as": "participant",
        }},
        {"$unwind": {"path": "$participant", "preserveNullAndEmptyArrays": True}},
    ]
    if category:
        pipeline.append({"$match": {"participant.category": category}})
    if source == "self":
        pipeline.append({"$match": {"participant.source": "self"}})
    elif source == "imported":
        pipeline.append({"$match": {
            "$or": [
                {"participant.source": "imported"},
                {"participant.source": {"$exists": False}},
            ],
        }})
    elif source == "staff":
        pipeline.append({"$match": {"participant.source": "staff"}})
    elif source == "exclude_staff":
        pipeline.append({"$match": {"participant.source": {"$ne": "staff"}}})
    pipeline += [
        {"$sort": {"submitted_at": -1}},
        {"$skip": skip},
        {"$limit": limit},
        {"$project": {
            "_id": 0,
            "token": 1,
            "survey_version": 1,
            "responses": 1,
            "submitted_at": 1,
            "updated_at": 1,
            "name": "$participant.name",
            "email": "$participant.email",
            "org": "$participant.org",
            "category": "$participant.category",
            "field": "$participant.field",
            "source": {"$ifNull": ["$participant.source", "imported"]},
            "consent_reward": {"$ifNull": ["$participant.consent_reward", False]},
            "reward_name": {"$ifNull": ["$participant.reward_name", ""]},
            "reward_phone": {"$ifNull": ["$participant.reward_phone", ""]},
            "consent_reward_at": "$participant.consent_reward_at",
            "consent_pi": {"$ifNull": ["$participant.consent_pi", False]},
            "consent_pi_at": "$participant.consent_pi_at",
        }},
    ]
    cursor = db.responses.aggregate(pipeline)
    results = [doc async for doc in cursor]
    return {"count": len(results), "data": results}


@router.get("/export")
async def export_csv(
    x_admin_key: Optional[str] = Header(None),
    source: Optional[str] = None,
):
    """응답 CSV 내보내기. source=self|imported 시 해당 출처 응답자만 추출."""
    _check_admin(x_admin_key)
    db = get_db()
    import csv, io, json as _json
    from fastapi.responses import StreamingResponse

    pipeline = [
        {"$lookup": {
            "from": "participants",
            "localField": "token",
            "foreignField": "token",
            "as": "p",
        }},
        {"$unwind": {"path": "$p", "preserveNullAndEmptyArrays": True}},
    ]
    if source == "self":
        pipeline.append({"$match": {"p.source": "self"}})
    elif source == "imported":
        pipeline.append({"$match": {"$or": [{"p.source": "imported"}, {"p.source": {"$exists": False}}]}})
    elif source == "staff":
        pipeline.append({"$match": {"p.source": "staff"}})
    elif source == "exclude_staff":
        pipeline.append({"$match": {"p.source": {"$ne": "staff"}}})
    pipeline.append({"$sort": {"submitted_at": 1}})
    cursor = db.responses.aggregate(pipeline)
    docs = [doc async for doc in cursor]

    if not docs:
        raise HTTPException(404, "응답 데이터가 없습니다.")

    all_keys = set()
    for d in docs:
        all_keys.update(d.get("responses", {}).keys())
    sorted_keys = sorted(all_keys)

    output = io.StringIO()
    writer = csv.writer(output)
    header = ["token", "name", "org", "category", "field", "source", "submitted_at", "updated_at"] + sorted_keys
    writer.writerow(header)

    for d in docs:
        p = d.get("p", {})
        resp = d.get("responses", {})
        row = [
            d.get("token", ""),
            p.get("name", ""),
            p.get("org", ""),
            p.get("category", ""),
            p.get("field", ""),
            p.get("source", "imported"),
            str(d.get("submitted_at", "")),
            str(d.get("updated_at", "")),
        ]
        for k in sorted_keys:
            v = resp.get(k, "")
            if isinstance(v, (list, dict)):
                row.append(_json.dumps(v, ensure_ascii=False))
            else:
                row.append(str(v) if v is not None else "")
        writer.writerow(row)

    output.seek(0)
    suffix = f"_{source}" if source in ("self", "imported") else ""
    return StreamingResponse(
        iter(["﻿" + output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=survey_responses{suffix}.csv"},
    )


@router.get("/participants")
async def list_participants(
    x_admin_key: Optional[str] = Header(None),
    category: Optional[str] = None,
    source: Optional[str] = None,
    skip: int = 0,
    limit: int = 5000,
):
    _check_admin(x_admin_key)
    db = get_db()
    match: dict = {}
    if category:
        match["category"] = category
    if source == "self":
        match["source"] = "self"
    elif source == "imported":
        # 과거 데이터(필드 부재)도 imported로 간주
        match["$or"] = [{"source": "imported"}, {"source": {"$exists": False}}]
    elif source == "staff":
        match["source"] = "staff"
    elif source == "exclude_staff":
        match["source"] = {"$ne": "staff"}

    pipeline = [
        {"$match": match},
        {"$lookup": {
            "from": "responses",
            "localField": "token",
            "foreignField": "token",
            "as": "resp",
        }},
        {"$addFields": {
            "responded": {"$gt": [{"$size": "$resp"}, 0]},
            "response_submitted_at": {"$arrayElemAt": ["$resp.submitted_at", 0]},
            "response_updated_at": {"$arrayElemAt": ["$resp.updated_at", 0]},
        }},
        {"$project": {"resp": 0, "_id": 0}},
        {"$skip": skip},
        {"$limit": limit},
    ]
    cursor = db.participants.aggregate(pipeline)
    results = [doc async for doc in cursor]
    total = await db.participants.count_documents(match)
    return {"total": total, "count": len(results), "data": results}


# ── Participant CRUD ──

class ParticipantCreate(BaseModel):
    name: str
    email: str
    org: Optional[str] = ""
    phone: Optional[str] = ""
    category: Optional[str] = ""
    field: Optional[str] = ""


@router.post("/participants")
async def create_participant(body: ParticipantCreate, x_admin_key: Optional[str] = Header(None)):
    _check_admin(x_admin_key)
    from services.token_service import generate_token
    s = get_settings()
    db = get_db()

    email = body.email.lower().strip()
    if not email:
        raise HTTPException(400, "이메일은 필수입니다.")
    existing = await db.participants.find_one({"email": email})
    if existing:
        raise HTTPException(409, "이미 등록된 이메일입니다.")

    token = generate_token(email, s.TOKEN_SECRET)
    doc = {
        "token": token,
        "name": body.name.strip(),
        "email": email,
        "org": (body.org or "").strip(),
        "phone": (body.phone or "").strip(),
        "category": (body.category or "").strip(),
        "field": (body.field or "").strip(),
        "created_at": datetime.now(timezone.utc),
    }
    await db.participants.insert_one(doc)
    saved = await db.participants.find_one({"token": token}, {"_id": 0})
    return {"status": "created", "participant": saved}


@router.delete("/participants/{token}")
async def delete_participant(token: str, x_admin_key: Optional[str] = Header(None)):
    _check_admin(x_admin_key)
    db = get_db()
    result = await db.participants.delete_one({"token": token})
    if result.deleted_count == 0:
        raise HTTPException(404, "대상자를 찾을 수 없습니다.")
    # 응답·로그도 함께 삭제하고 싶으면 여기에 추가 (현재는 응답 보존)
    return {"status": "deleted", "token": token}


# ── Email ──

class EmailSendRequest(BaseModel):
    tokens: list[str]
    subject: Optional[str] = None  # None 이면 type 기반 자동 subject
    type: str = "invite"  # invite | reminder | deadline | custom


class EmailCustomSendRequest(BaseModel):
    tokens: list[str]
    subject: str
    body_html: str  # {{name}} {{org}} {{survey_url}} 치환


@router.get("/email/preview", response_class=HTMLResponse)
async def email_preview(
    x_admin_key: Optional[str] = Header(None),
    type: str = "invite",
    token: Optional[str] = None,
):
    """미리보기 — token 지정시 해당 참가자 데이터로 치환, 미지정 시 샘플."""
    _check_admin(x_admin_key)
    s = get_settings()
    name, org = "홍길동", "예시 기관"
    survey_url = _normalize_survey_url(s.SURVEY_BASE_URL, "SAMPLE_TOKEN")
    if token:
        db = get_db()
        p = await db.participants.find_one({"token": token})
        if p:
            name = p.get("name", "") or name
            org = p.get("org", "") or org
            survey_url = _normalize_survey_url(s.SURVEY_BASE_URL, p["token"])
    return render_email(name, org, survey_url, type)


@router.post("/email/send")
async def send_survey_emails(
    body: EmailSendRequest,
    x_admin_key: Optional[str] = Header(None),
):
    admin = _check_admin(x_admin_key)
    s = get_settings()
    if not s.GMAIL_USER or not s.GMAIL_APP_PASSWORD:
        raise HTTPException(500, "Gmail 설정이 없습니다.")

    email_type = body.type if body.type in ALLOWED_EMAIL_TYPES else "invite"
    subject = email_subject_for(email_type, body.subject)
    batch_id = uuid4().hex[:12]
    db = get_db()
    results = {
        "batch_id": batch_id,
        "type": email_type,
        "subject": subject,
        "sent": 0,
        "failed": 0,
        "skipped": 0,
        "errors": [],
    }

    for token in body.tokens:
        p = await db.participants.find_one({"token": token})
        if not p:
            results["skipped"] += 1
            continue

        survey_url = _normalize_survey_url(s.SURVEY_BASE_URL, token)
        html = render_email(p.get("name", ""), p.get("org", ""), survey_url, email_type)
        now = datetime.now(timezone.utc)

        log_doc = {
            "batch_id": batch_id,
            "token": token,
            "email": p["email"],
            "name": p.get("name", ""),
            "org": p.get("org", ""),
            "category": p.get("category", ""),
            "type": email_type,
            "subject": subject,
            "admin_email": admin.get("email", ""),
            "admin_name": admin.get("name", ""),
            "sent_at": now,
        }

        try:
            send_email(p["email"], subject, html)
            log_doc.update({"status": "sent", "error": ""})
            await db.email_logs.insert_one(log_doc)
            await db.participants.update_one(
                {"token": token},
                [{"$set": {
                    "email_sent": True,
                    "email_sent_at": now,
                    "email_last_sent_at": now,
                    "email_first_sent_at": {"$ifNull": ["$email_first_sent_at", now]},
                    "email_sent_count": {"$add": [{"$ifNull": ["$email_sent_count", 0]}, 1]},
                    "email_last_status": "sent",
                    "email_last_type": email_type,
                    "email_last_error": "",
                }}],
            )
            results["sent"] += 1
        except Exception as e:
            err_msg = str(e)
            logger.error(f"Email failed for {p['email']}: {err_msg}")
            log_doc.update({"status": "failed", "error": err_msg})
            await db.email_logs.insert_one(log_doc)
            await db.participants.update_one(
                {"token": token},
                {"$set": {
                    "email_last_status": "failed",
                    "email_last_attempt_at": now,
                    "email_last_type": email_type,
                    "email_last_error": err_msg,
                }},
            )
            results["failed"] += 1
            results["errors"].append({"token": token, "email": p["email"], "error": err_msg})

    return results


@router.post("/email/custom-send")
async def send_custom_emails(
    body: EmailCustomSendRequest,
    x_admin_key: Optional[str] = Header(None),
):
    admin = _check_admin(x_admin_key)
    s = get_settings()
    if not s.GMAIL_USER or not s.GMAIL_APP_PASSWORD:
        raise HTTPException(500, "Gmail 설정이 없습니다.")

    subject = (body.subject or "").strip()
    body_html = (body.body_html or "").strip()
    if not subject:
        raise HTTPException(400, "제목을 입력해 주십시오.")
    if not body_html:
        raise HTTPException(400, "본문을 입력해 주십시오.")
    if not body.tokens:
        raise HTTPException(400, "수신자가 없습니다.")

    batch_id = uuid4().hex[:12]
    db = get_db()
    results = {
        "batch_id": batch_id,
        "type": "custom",
        "sent": 0,
        "failed": 0,
        "skipped": 0,
        "errors": [],
    }

    for token in body.tokens:
        p = await db.participants.find_one({"token": token})
        if not p:
            results["skipped"] += 1
            continue

        survey_url = _normalize_survey_url(s.SURVEY_BASE_URL, token)
        html = render_custom(p.get("name", ""), p.get("org", ""), survey_url, body_html)
        now = datetime.now(timezone.utc)

        log_doc = {
            "batch_id": batch_id,
            "token": token,
            "email": p["email"],
            "name": p.get("name", ""),
            "org": p.get("org", ""),
            "category": p.get("category", ""),
            "type": "custom",
            "subject": subject,
            "admin_email": admin.get("email", ""),
            "admin_name": admin.get("name", ""),
            "sent_at": now,
        }

        try:
            send_email(p["email"], subject, html)
            log_doc.update({"status": "sent", "error": ""})
            await db.email_logs.insert_one(log_doc)
            await db.participants.update_one(
                {"token": token},
                [{"$set": {
                    "email_sent": True,
                    "email_sent_at": now,
                    "email_last_sent_at": now,
                    "email_first_sent_at": {"$ifNull": ["$email_first_sent_at", now]},
                    "email_sent_count": {"$add": [{"$ifNull": ["$email_sent_count", 0]}, 1]},
                    "email_last_status": "sent",
                    "email_last_type": "custom",
                    "email_last_error": "",
                }}],
            )
            results["sent"] += 1
        except Exception as e:
            err_msg = str(e)
            logger.error(f"Custom email failed for {p['email']}: {err_msg}")
            log_doc.update({"status": "failed", "error": err_msg})
            await db.email_logs.insert_one(log_doc)
            await db.participants.update_one(
                {"token": token},
                {"$set": {
                    "email_last_status": "failed",
                    "email_last_attempt_at": now,
                    "email_last_type": "custom",
                    "email_last_error": err_msg,
                }},
            )
            results["failed"] += 1
            results["errors"].append({"token": token, "email": p["email"], "error": err_msg})

    return results


@router.post("/email/custom-preview", response_class=HTMLResponse)
async def custom_email_preview(
    body: EmailCustomSendRequest,
    x_admin_key: Optional[str] = Header(None),
):
    _check_admin(x_admin_key)
    s = get_settings()
    name = "홍길동"
    org = "예시 기관"
    survey_url = _normalize_survey_url(s.SURVEY_BASE_URL, "SAMPLE_TOKEN")
    if body.tokens:
        db = get_db()
        p = await db.participants.find_one({"token": body.tokens[0]})
        if p:
            name = p.get("name", "") or name
            org = p.get("org", "") or org
            survey_url = _normalize_survey_url(s.SURVEY_BASE_URL, p["token"])
    return render_custom(name, org, survey_url, body.body_html or "")


@router.get("/email/logs")
async def list_email_logs(
    x_admin_key: Optional[str] = Header(None),
    token: Optional[str] = None,
    status: Optional[str] = None,
    type: Optional[str] = None,
    batch_id: Optional[str] = None,
    skip: int = 0,
    limit: int = 200,
):
    _check_admin(x_admin_key)
    db = get_db()
    query: dict = {}
    if token:
        query["token"] = token
    if status:
        query["status"] = status
    if type:
        query["type"] = type
    if batch_id:
        query["batch_id"] = batch_id

    total = await db.email_logs.count_documents(query)
    cursor = (
        db.email_logs.find(query, {"_id": 0})
        .sort("sent_at", -1)
        .skip(skip)
        .limit(min(limit, 1000))
    )
    items = [doc async for doc in cursor]
    return {"total": total, "count": len(items), "data": items}


@router.get("/email/history")
async def email_history(
    x_admin_key: Optional[str] = Header(None),
    category: Optional[str] = None,
):
    _check_admin(x_admin_key)
    db = get_db()
    p_query: dict = {"email_sent": True}
    if category:
        p_query["category"] = category
    sent_count = await db.participants.count_documents(p_query)
    total = await db.participants.count_documents({"category": category} if category else {})

    log_total = await db.email_logs.count_documents({})
    log_sent = await db.email_logs.count_documents({"status": "sent"})
    log_failed = await db.email_logs.count_documents({"status": "failed"})

    by_type_cursor = db.email_logs.aggregate([
        {"$match": {"status": "sent"}},
        {"$group": {"_id": "$type", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ])
    by_type = {(doc["_id"] or "unknown"): doc["count"] async for doc in by_type_cursor}

    return {
        "unique_recipients_sent": sent_count,
        "total_participants": total,
        "log_total": log_total,
        "log_sent": log_sent,
        "log_failed": log_failed,
        "by_type": by_type,
    }
