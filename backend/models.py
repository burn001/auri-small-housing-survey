from pydantic import BaseModel, Field
from typing import Any, Optional
from datetime import datetime


class Participant(BaseModel):
    token: str
    email: str
    name: str
    org: str = ""
    category: str = ""
    field: str = ""
    phone: str = ""
    # 등록 출처: imported(엑셀 import) | self(공개 링크 자가등록)
    source: str = "imported"
    # 자가등록 시 개인정보 수집·이용 동의 — 자가등록자만 채워짐
    consent_pi: bool = False
    consent_pi_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SelfRegisterRequest(BaseModel):
    """공개 단일 링크 자가등록 페이로드.

    필수: email(완료 메일·본인 확인 채널), name, consent_pi.
    선택: org, category(SQ1 분류와 동일 옵션 권장).
    사례품 동의는 응답 제출 시점에 받으므로 자가등록 단계에서는 받지 않는다.
    is_staff=True 진입(`?source=staff`)은 직원 테스트 모드 — source='staff'로 기록되어
    관리자 분석 화면에서 별도 분리/제외할 수 있다.
    """
    email: str
    name: str
    org: str = ""
    category: str = ""
    consent_pi: bool
    is_staff: bool = False


class RecoverRequest(BaseModel):
    """기존 자가등록자가 토큰 링크를 분실한 경우 — email로 본인 토큰 링크 재발송."""
    email: str


class ParticipantOut(BaseModel):
    token: str
    name: str
    org: str = ""
    category: str = ""
    has_responded: bool = False


class ParticipantUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    org: Optional[str] = None
    phone: Optional[str] = None


class ResponseSubmit(BaseModel):
    token: str
    survey_version: str = "v10.0"
    responses: dict[str, Any]
    consent_reward: Optional[bool] = None  # None = 옛 v9.1 이전 응답 호환
    reward_phone: Optional[str] = None


class ResponseRecord(BaseModel):
    token: str
    survey_version: str
    responses: dict[str, Any]
    submitted_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = None
    ip: str = ""
    user_agent: str = ""


class StatsOut(BaseModel):
    total_participants: int
    total_responses: int
    by_category: dict[str, dict[str, int]]
