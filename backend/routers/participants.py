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
async def get_stats(x_admin_key: Optional[str] = Header(None)):
    _check_admin(x_admin_key)
    db = get_db()

    total_p = await db.participants.count_documents({})
    total_r = await db.responses.count_documents({})

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
    }


@router.get("/responses")
async def list_responses(
    x_admin_key: Optional[str] = Header(None),
    skip: int = 0,
    limit: int = 200,
    category: Optional[str] = None,
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
        }},
    ]
    cursor = db.responses.aggregate(pipeline)
    results = [doc async for doc in cursor]
    return {"count": len(results), "data": results}


@router.get("/export")
async def export_csv(x_admin_key: Optional[str] = Header(None)):
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
        {"$sort": {"submitted_at": 1}},
    ]
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
    header = ["token", "name", "org", "category", "field", "submitted_at", "updated_at"] + sorted_keys
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
    return StreamingResponse(
        iter(["﻿" + output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=survey_responses.csv"},
    )


@router.get("/participants")
async def list_participants(
    x_admin_key: Optional[str] = Header(None),
    category: Optional[str] = None,
    skip: int = 0,
    limit: int = 5000,
):
    _check_admin(x_admin_key)
    db = get_db()
    match: dict = {}
    if category:
        match["category"] = category

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
