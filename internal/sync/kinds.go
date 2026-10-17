package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/pixari/opentodo/internal/recurrence"
	"github.com/pixari/opentodo/internal/zoned"
)

// kindChecks validates an op value per field kind (see the kind constants in
// ops.go). checkKind looks the check up; kinds_test.go keeps the table whole.
var kindChecks = map[kind]func(raw json.RawMessage) error{
	kString:         checkString,
	kNullableString: orNull(checkIDString),
	kNumber:         checkNumber,
	kNullableNumber: orNull(checkNullableNumber),
	kBool:           checkBool,
	kPriority:       checkPriority,
	kStart:          orNull(checkStart),
	kDate:           orNull(checkDate),
	kDue:            orNull(checkDue),
	kStringList:     checkStringList,
	kIDList:         checkIDList,
	kPositiveInt:    orNull(checkPositiveInt),
	kRecurrence:     orNull(checkRecurrence),
	kID:             checkID,
	kReminderKind:   checkReminderKind,
	kOffsetMinutes:  orNull(checkOffsetMinutes),
	kNullableText:   orNull(checkNullableText),
	kDoc:            checkDoc,
	kFieldValue:     checkFieldValue,
	kInstant:        orNull(checkInstant),
}

func isNullValue(raw json.RawMessage) bool { return string(raw) == "null" }

// orNull accepts JSON null and otherwise runs check.
func orNull(check func(json.RawMessage) error) func(json.RawMessage) error {
	return func(raw json.RawMessage) error {
		if isNullValue(raw) {
			return nil
		}
		return check(raw)
	}
}

func checkString(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || !utf8.ValidString(s) {
		return errors.New("must be a string")
	}
	return nil
}

func checkIDString(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || len(s) > MaxIDLen {
		return errors.New("must be null or an id string")
	}
	return nil
}

func checkNumber(raw json.RawMessage) error {
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return errors.New("must be a number")
	}
	return nil
}

func checkNullableNumber(raw json.RawMessage) error {
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return errors.New("must be null or a number")
	}
	return nil
}

// checkBool refuses null explicitly: json.Unmarshal leaves a bool untouched on
// null (OpenSpec change habits: a non-boolean flag is invalid).
func checkBool(raw json.RawMessage) error {
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil || isNullValue(raw) {
		return errors.New("must be a boolean")
	}
	return nil
}

func checkPriority(raw json.RawMessage) error {
	var p int
	if err := json.Unmarshal(raw, &p); err != nil || p < 1 || p > 4 {
		return errors.New("must be an integer from 1 (highest) to 4 (lowest)")
	}
	return nil
}

func checkStart(raw json.RawMessage) error {
	var d string
	if err := json.Unmarshal(raw, &d); err != nil || (d != "someday" && !isDate(d)) {
		return errors.New(`must be null, "someday" or a date "YYYY-MM-DD"`)
	}
	if d != "someday" {
		if _, err := time.Parse("2006-01-02", d); err != nil {
			return errors.New(`must be null, "someday" or a date "YYYY-MM-DD" that exists`)
		}
	}
	return nil
}

func checkDate(raw json.RawMessage) error {
	var d string
	if err := json.Unmarshal(raw, &d); err != nil || !isDate(d) {
		return errors.New(`must be null or a date "YYYY-MM-DD"`)
	}
	if _, err := time.Parse("2006-01-02", d); err != nil {
		return errors.New(`must be null or a date "YYYY-MM-DD" that exists`)
	}
	return nil
}

func checkDue(raw json.RawMessage) error {
	var d struct {
		Date string  `json:"date"`
		Time *string `json:"time"`
		TZ   *string `json:"tz"`
	}
	if err := json.Unmarshal(raw, &d); err != nil || !isDate(d.Date) || (d.Time != nil && !isClock(*d.Time)) {
		return errors.New(`must be null or {"date":"YYYY-MM-DD","time":"HH:MM"?,"tz":"Area/City"?}`)
	}
	// The date must exist and the time be a clock reading 00:00-23:59
	// (sync-convergence): recurrence and reminders compute from them.
	if _, err := time.Parse("2006-01-02", d.Date); err != nil {
		return errors.New(`must be null or a due whose date "YYYY-MM-DD" exists`)
	}
	if d.Time != nil {
		if _, err := time.Parse("15:04", *d.Time); err != nil {
			return errors.New(`must be null or a due whose time "HH:MM" is between 00:00 and 23:59`)
		}
	}
	// A zoned due (OpenSpec change absolute-datetimes) names a known IANA
	// zone and always has a time.
	if d.TZ != nil {
		if d.Time == nil {
			return errors.New("tz requires time")
		}
		if !zoned.Valid(*d.TZ) {
			return fmt.Errorf("tz must be a known IANA time zone of at most %d characters", zoned.MaxZoneLen)
		}
	}
	return nil
}

func checkStringList(raw json.RawMessage) error {
	var l []string
	if err := json.Unmarshal(raw, &l); err != nil || l == nil {
		return errors.New("must be an array of strings")
	}
	return nil
}

func checkIDList(raw json.RawMessage) error {
	var l []string
	if err := json.Unmarshal(raw, &l); err != nil || l == nil {
		return errors.New("must be an array of task ids")
	}
	if len(l) > MaxBlockedBy {
		return fmt.Errorf("may hold at most %d ids", MaxBlockedBy)
	}
	seen := make(map[string]bool, len(l))
	for _, id := range l {
		if id == "" || len(id) > MaxIDLen {
			return fmt.Errorf("ids must be 1 to %d characters", MaxIDLen)
		}
		if seen[id] {
			return fmt.Errorf("lists %q twice", id)
		}
		seen[id] = true
	}
	return nil
}

// checkPositiveInt unmarshals into an integer, which rejects fractions,
// exponents and strings.
func checkPositiveInt(raw json.RawMessage) error {
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil || n < 1 || n > MaxPositiveInt {
		return fmt.Errorf("must be null or an integer from 1 to %d", MaxPositiveInt)
	}
	return nil
}

func checkRecurrence(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return errors.New("must be null or a recurrence rule string")
	}
	if _, err := recurrence.Parse(s); err != nil {
		return err
	}
	return nil
}

func checkID(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || s == "" || len(s) > MaxIDLen {
		return errors.New("must be an id string")
	}
	return nil
}

func checkReminderKind(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || (s != "relative" && s != "absolute" && s != "deadline") {
		return errors.New(`must be "relative", "absolute" or "deadline"`)
	}
	return nil
}

func checkOffsetMinutes(raw json.RawMessage) error {
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil || n < -MaxReminderOffset || n > MaxReminderOffset {
		return fmt.Errorf("must be null or an integer from -%d to %d", MaxReminderOffset, MaxReminderOffset)
	}
	return nil
}

func checkNullableText(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || !utf8.ValidString(s) {
		return errors.New("must be null or a string")
	}
	return nil
}

func checkDoc(raw json.RawMessage) error {
	var s string
	if err := json.Unmarshal(raw, &s); isNullValue(raw) || err != nil || !ValidDoc(s) {
		return fmt.Errorf(`must be "" or a document envelope "<format>:v<n>:<base64>" of at most %d characters`, MaxDocBytes)
	}
	return nil
}

func checkFieldValue(raw json.RawMessage) error {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return errors.New("must be null, a string, a number or a boolean")
	}
	switch x := v.(type) {
	case nil, bool, float64:
	case string:
		if !utf8.ValidString(x) {
			return errors.New("must be valid text")
		}
	default:
		return errors.New("must be null, a string, a number or a boolean")
	}
	return nil
}

func checkInstant(raw json.RawMessage) error {
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil || f <= 0 {
		return errors.New("must be null or a positive unix millisecond timestamp")
	}
	return nil
}
