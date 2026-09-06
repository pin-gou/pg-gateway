import { expect, test } from '../../core/fixtures/base.fixture'

/**
 * @file TDD Red Phase — RTK plugin configuration fragment E2E tests (dev.ui task 11.1)
 *
 * Contract (design.md "组件设计"):
 *   - rtkFragment renders when the built-in "rtk" plugin is selected in /workspace/plugins
 *   - Fragment fields: enabled (Switch), intensity (Select), max_lines_per_result (Number input),
 *     max_chars_per_result (Number input), dedup_threshold (Number input),
 *     raw_output_retention (Select), apply_to_tool_results (Checkbox),
 *     apply_to_code_blocks (Checkbox), apply_to_assistant_messages (Checkbox),
 *     enable_grouping (Switch), grouping_threshold (Number input),
 *     pipeline (JSON textarea), min_tokens_to_compress (Number input)
 *   - Enabled switch toggle → Save Changes → PATCH /api/plugins/rtk → 200
 *
 * In the TDD red phase, rtkFragment.tsx does not yet exist, and PluginsView
 * does not yet have a rendering path for name="rtk". The test will fail when
 * it cannot find the expected fragment fields. This is the expected TDD red-phase result.
 */

const RTK_PLUGIN_NAME = 'rtk'

test.describe('RTK Plugin Configuration', () => {
  test.beforeEach(async ({ pluginsPage }) => {
    await pluginsPage.goto()
    // Ensure sheet is closed before each test
    await pluginsPage.ensureSheetClosed()
  })

  test.afterEach(async ({ pluginsPage }) => {
    // Ensure sheet is closed after each test
    await pluginsPage.ensureSheetClosed()
  })

  test.describe('Fragment Rendering', () => {

    test('should display RTK fragment when rtk plugin is selected', async ({ pluginsPage, page }) => {
      // Verify the rtk plugin exists in the sidebar
      const rtkExists = await pluginsPage.pluginExists(RTK_PLUGIN_NAME)
      expect(rtkExists).toBe(true)

      // Click on the rtk plugin in the sidebar to select it
      const rtkButton = pluginsPage.getPluginButton(RTK_PLUGIN_NAME)
      await rtkButton.click()

      // Wait for the plugin details view to load
      await page.waitForLoadState('networkidle')

      // The RTK fragment should render — assert key fields appear
      // Enabled switch (the fragment has its own enabled switch distinct from the generic one)
      const enabledSwitch = page.locator('button[role="switch"]').first()
      await expect(enabledSwitch).toBeVisible()

      // Intensity select (drop-down: minimal / standard / aggressive)
      const intensitySelect = page.locator('select, [role="combobox"]').filter({ hasText: /intensity/i }).first()
      // Fallback: look for a label containing "Intensity"
      const intensityLabel = page.getByText(/intensity/i).first()
      await expect(intensityLabel.or(intensitySelect)).toBeVisible()

      // max_lines_per_result input
      const maxLinesInput = page.locator('input').filter({ has: page.locator('[value]') }).or(
        page.getByLabel(/max lines/i)
      ).first()
      // Look for the label
      const maxLinesLabel = page.getByText(/max lines/i).first()
      await expect(maxLinesLabel.or(maxLinesInput)).toBeVisible()

      // max_chars_per_result input
      const maxCharsLabel = page.getByText(/max chars/i).first()
      await expect(maxCharsLabel).toBeVisible()

      // dedup_threshold input
      const dedupLabel = page.getByText(/dedup/i).first()
      await expect(dedupLabel).toBeVisible()

      // raw_output_retention select
      const rawOutputLabel = page.getByText(/raw output/i).first()
      await expect(rawOutputLabel).toBeVisible()
    })

    test('should render all RTK field groups', async ({ pluginsPage, page }) => {
      const rtkExists = await pluginsPage.pluginExists(RTK_PLUGIN_NAME)
      expect(rtkExists).toBe(true)

      const rtkButton = pluginsPage.getPluginButton(RTK_PLUGIN_NAME)
      await rtkButton.click()
      await page.waitForLoadState('networkidle')

      // Field groups from design.md:
      // 1. 启用与强度: enabled + intensity
      await expect(page.getByText(/intensity/i).first()).toBeVisible()

      // 2. 行/字符上限: max_lines_per_result, max_chars_per_result, dedup_threshold
      await expect(page.getByText(/max (lines|chars)/i).first()).toBeVisible()

      // 3. 作用范围: apply_to_tool_results, apply_to_code_blocks, apply_to_assistant_messages
      const toolResultsLabel = page.getByText(/tool results/i).first()
      const codeBlocksLabel = page.getByText(/code blocks/i).first()
      const assistantMessagesLabel = page.getByText(/assistant messages/i).first()
      await expect(toolResultsLabel.or(codeBlocksLabel).or(assistantMessagesLabel)).toBeVisible()

      // 4. 分组: enable_grouping, grouping_threshold
      const groupingLabel = page.getByText(/grouping/i).first()
      await expect(groupingLabel).toBeVisible()

      // 5. 原始输出: raw_output_retention, raw_output_max_bytes
      const rawOutputLabel = page.getByText(/raw output/i).first()
      await expect(rawOutputLabel).toBeVisible()

      // 6. 高级: pipeline (JSON textarea), min_tokens_to_compress
      const pipelineLabel = page.getByText(/pipeline/i).first()
      const minTokensLabel = page.getByText(/min.*tokens/i).first()
      await expect(pipelineLabel.or(minTokensLabel)).toBeVisible()
    })
  })

  test.describe('Plugin Submit', () => {

    test('should toggle enabled switch and submit successfully', async ({ pluginsPage, page }) => {
      const rtkExists = await pluginsPage.pluginExists(RTK_PLUGIN_NAME)
      expect(rtkExists).toBe(true)

      const rtkButton = pluginsPage.getPluginButton(RTK_PLUGIN_NAME)
      await rtkButton.click()
      await page.waitForLoadState('networkidle')

      // Get the initial enabled state
      const enabledSwitch = page.locator('button[role="switch"]').first()
      await expect(enabledSwitch).toBeVisible()

      // Toggle the enabled switch
      await enabledSwitch.click()

      // Wait for Save Changes button to become enabled
      const saveBtn = page.getByRole('button', { name: /Save Changes/i })
      await expect(saveBtn).toBeEnabled({ timeout: 5000 })

      // Click Save Changes
      await saveBtn.click()

      // Wait for success toast (API returned 200)
      const successToast = pluginsPage.getToast('success')
      await expect(successToast).toBeVisible({ timeout: 10000 })

      await pluginsPage.dismissToasts()
    })

    // Regression guard for the production incident where the UI top-level
    // toggle flipped only the plugin-level Enabled flag, leaving the inner
    // config.enabled divergent. The toggle now mirrors the switch into the
    // inner config so the stored row stays self-consistent and the engine
    // gate in plugins/rtk/hooks.go (which reads config.Enabled) follows the
    // master switch. Intercept the PUT request and assert the inner
    // config.enabled matches the new switch state.
    test('toggle switch mirrors plugin-level Enabled into inner config.enabled on PUT', async ({ pluginsPage, page }) => {
      const rtkExists = await pluginsPage.pluginExists(RTK_PLUGIN_NAME)
      expect(rtkExists).toBe(true)

      const rtkButton = pluginsPage.getPluginButton(RTK_PLUGIN_NAME)
      await rtkButton.click()
      await page.waitForLoadState('networkidle')

      // Capture PUT /api/plugins/rtk body. useUpdatePluginMutation issues
      // the PUT immediately on toggle — no Save button required.
      const putRequestPromise = page.waitForRequest(
        (req) => req.method() === 'PUT' && req.url().includes('/api/plugins/rtk'),
        { timeout: 10000 },
      )

      const enabledSwitch = page.locator('button[role="switch"]').first()
      await expect(enabledSwitch).toBeVisible()
      const initialState = await enabledSwitch.getAttribute('data-state')
      const newSwitchState = initialState === 'checked' ? 'unchecked' : 'checked'
      const newEnabled = newSwitchState === 'checked'
      await enabledSwitch.click()

      const putRequest = await putRequestPromise
      const postData = putRequest.postData()
      expect(postData, 'PUT /api/plugins/rtk must carry a JSON body').toBeTruthy()
      const body = JSON.parse(postData!) as {
        enabled?: boolean
        config?: { enabled?: unknown; [k: string]: unknown }
      }
      expect(body.enabled).toBe(newEnabled)
      // The inner config.enabled MUST mirror the switch. A missing field
      // or a divergent value (e.g. a stale UI snapshot still saying
      // enabled:false) is exactly the regression that put /workspace/logs
      // RTK column in a permanently-empty state.
      expect(body.config).toBeDefined()
      expect(body.config!.enabled).toBe(newEnabled)

      await pluginsPage.dismissToasts()
    })
  })
})