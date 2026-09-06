package rtk

import "github.com/pin-gou/celer-route/core/schemas"

// CompressionState holds per-request compression state, stored in the Plugin's
// sync.Map keyed by request ID. Populated by PreLLMHook and consumed by PostLLMHook.
type CompressionState struct {
	OriginalTokens    int
	CompressedTokens  int
	Compressed        bool
	Techniques        []string
	FilterMatched     string
	RawOutputPointers []*RtkRawOutputPointer
	// ScannedIndices records the message/block indices that the RTK pipeline
	// actually evaluated for compression this request, regardless of whether
	// the compressed output was smaller than the original. It powers the
	// "participated but not compressed" state in the log detail diff view
	// without persisting the message text itself — the original text for any
	// index where the pipeline did compress is recovered from the raw-output
	// file referenced by RawOutputPointers (rtk_raw_output_id).
	ScannedIndices []int
	// RawOutputEntries carries per-message raw-output pointer metadata
	// (scanned index + pointer ID) so the log detail view can render one
	// "View raw output" link per compressed message. Populated alongside
	// RawOutputPointers during compression; consumed by PostLLMHook which
	// exposes them via BifrostContextKeyRTKRawOutputEntries.
	RawOutputEntries []schemas.RTKRawOutputEntry
}

// NewCompressionState creates a new CompressionState with default values.
func NewCompressionState() *CompressionState {
	return &CompressionState{
		Techniques:        make([]string, 0),
		RawOutputPointers: make([]*RtkRawOutputPointer, 0),
		ScannedIndices:    make([]int, 0),
		RawOutputEntries:  make([]schemas.RTKRawOutputEntry, 0),
	}
}

// appendScanned records that the RTK pipeline evaluated the message/block at
// the given index, regardless of whether the resulting compression saved any
// tokens. Used by the log detail view to distinguish "did not participate"
// from "participated but not compressed" without persisting the text itself.
func appendScanned(state *CompressionState, index int) {
	state.ScannedIndices = append(state.ScannedIndices, index)
}

// setState stores the compression state for the given context's request ID.
func (p *Plugin) setState(ctx *schemas.BifrostContext, state *CompressionState) {
	reqID := ctx.Value(schemas.BifrostContextKeyRequestID)
	if reqID == nil {
		// Fallback: use a placeholder if no request ID is available
		p.stateStore.Store("default", state)
		return
	}
	id, ok := reqID.(string)
	if !ok {
		p.stateStore.Store("default", state)
		return
	}
	p.stateStore.Store(id, state)
}

// getState retrieves the compression state for the given context's request ID.
func (p *Plugin) getState(ctx *schemas.BifrostContext) *CompressionState {
	reqID := ctx.Value(schemas.BifrostContextKeyRequestID)
	if reqID == nil {
		v, ok := p.stateStore.Load("default")
		if !ok {
			return nil
		}
		state, _ := v.(*CompressionState)
		return state
	}
	id, ok := reqID.(string)
	if !ok {
		v, ok := p.stateStore.Load("default")
		if !ok {
			return nil
		}
		state, _ := v.(*CompressionState)
		return state
	}
	v, ok := p.stateStore.Load(id)
	if !ok {
		return nil
	}
	state, _ := v.(*CompressionState)
	return state
}

// getCompressionState retrieves the compression state for PostLLMHook.
// Returns nil if no compression state exists for this request.
func (p *Plugin) getCompressionState(ctx *schemas.BifrostContext) *CompressionState {
	return p.getState(ctx)
}

// clearCompressionState removes the compression state for the given context's request ID.
func (p *Plugin) clearCompressionState(ctx *schemas.BifrostContext) {
	reqID := ctx.Value(schemas.BifrostContextKeyRequestID)
	if reqID == nil {
		p.stateStore.Delete("default")
		return
	}
	id, ok := reqID.(string)
	if !ok {
		p.stateStore.Delete("default")
		return
	}
	p.stateStore.Delete(id)
}
