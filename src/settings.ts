import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	SliderComponent,
	TextComponent,
} from 'obsidian';
import LanguageToolPlugin from './main';
import { Language, SYNONYMS, languages } from "./api";

const autoCheckDelayMax = 5000;
const autoCheckDelayStep = 250;

class Endpoint {
	url: string;
	requestsPerSec: number;

	constructor(url: string, requestsPerSec: number) {
		this.url = url;
		this.requestsPerSec = requestsPerSec;
	}
	/** Return the minimum delay in ms */
	get minDelay() {
		return (60 / this.requestsPerSec) * 1000;
	}
}

/** See https://languagetool.org/http-api/swagger-ui/# */
const endpoints = {
	standard: new Endpoint('https://api.languagetool.org', 20),
	premium: new Endpoint('https://api.languagetoolplus.com', 80),
	custom: new Endpoint('', 120),
};
type EndpointType = keyof typeof endpoints;

function endpointFromUrl(url: string): EndpointType {
	for (const [key, value] of Object.entries(endpoints)) {
		if (value.url === url) return key as EndpointType;
	}
	return 'custom';
}

export interface LTSettings {
	serverUrl: string;
	apikey?: string;
	username?: string;

	shouldAutoCheck: boolean;
	autoCheckDelay: number;
	synonyms?: string;

	motherTongue?: string;
	staticLanguage?: string;
	languageVariety: Record<string, string>;

	pickyMode: boolean;
	enabledCategories?: string;
	disabledCategories?: string;
	enabledRules?: string;
	disabledRules?: string;
}

export const DEFAULT_SETTINGS: LTSettings = {
	serverUrl: endpoints["standard"].url,
	autoCheckDelay: endpoints.standard.minDelay,
	shouldAutoCheck: false,
	languageVariety: {
		"en": "en-US",
		"de": "de-DE",
	},
	pickyMode: false,
};

interface EndpointListener {
	(e: string): Promise<void>
}
interface LanguageListener {
	(l: Language[]): Promise<void>
}
function languageVariants(languages: Language[], code: string): Record<string, string> {
	languages = languages.filter(v => v.code === code).filter(v => v.longCode !== v.code);
	return Object.fromEntries(languages.map(v => [v.longCode, v.name]));
}

export class LTSettingsTab extends PluginSettingTab {
	private readonly plugin: LanguageToolPlugin;
	private endpointListeners: EndpointListener[] = [];
	private languageListeners: LanguageListener[] = [];

	public constructor(app: App, plugin: LanguageToolPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private configureCheckDelay(slider: SliderComponent, value: EndpointType): void {
		const minAutoCheckDelay = endpoints[value].minDelay;
		this.plugin.settings.autoCheckDelay = Math.clamp(
			this.plugin.settings.autoCheckDelay, minAutoCheckDelay, autoCheckDelayMax);
		slider.setLimits(minAutoCheckDelay, autoCheckDelayMax, autoCheckDelayStep);
	}

	public async notifyEndpointChange(settings: LTSettings): Promise<void> {
		for (const listener of this.endpointListeners) {
			await listener(settings.serverUrl);
		}
	}

	private async configureLanguageVariants(
		dropdown: DropdownComponent,
		code: string,
		staticLanguage: DropdownComponent | null
	): Promise<void> {
		const settings = this.plugin.settings;
		dropdown
			.addOption("default", '---')
			.setValue('default')
			.onChange(async value => {
				if (value === 'default') {
					delete settings.languageVariety[code];
				} else {
					settings.staticLanguage = 'auto';
					staticLanguage?.setValue('auto');
					settings.languageVariety[code] = value;
				}
				await this.plugin.saveSettings();
			});

		this.languageListeners.push(async l => {
			// Clear options
			while (dropdown.selectEl.options.length > 0) {
				dropdown.selectEl.remove(0);
			}

			dropdown
				.addOptions({ default: '---', ...languageVariants(l, code) })
				.setValue(settings.languageVariety[code] ?? 'default')
		})
	}

	public async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.settings;

		this.endpointListeners = [async url => {
			let lang: Language[] = [];
			if (url) lang = await languages(url);
			for (const listener of this.languageListeners) {
				await listener(lang);
			}
		}];
		this.languageListeners = [];


		new Setting(containerEl)
			.setName('Error logs')
			.setDesc(`${this.plugin.logs.length} messages`)
			.addButton(component => {
				component.setButtonText('Copy to clipboard').onClick(async () => {
					await window.navigator.clipboard.writeText(this.plugin.logs.join('\n'));
					new Notice('Logs copied to clipboard');
				});
			})

		let endpoint = endpointFromUrl(settings.serverUrl);
		let autoCheckDelaySlider: SliderComponent | null = null;

		new Setting(containerEl)
			.setName('Endpoint')
			.setDesc('Choose the LanguageTool server url')
			.then(setting => {
				setting.controlEl.classList.add('lt-settings-grid');

				let dropdown: DropdownComponent | null = null;
				let input: TextComponent | null = null;
				setting.addDropdown(component => {
					dropdown = component;
					component
						.addOptions({
							standard: '(Standard) api.languagetool.org',
							premium: '(Premium) api.languagetoolplus.com',
							custom: 'Custom URL',
						})
						.setValue(endpoint)
						.onChange(async value => {
							endpoint = value as EndpointType;
							settings.serverUrl = endpoints[endpoint].url;

							if (input)
								input.setValue(settings.serverUrl)
									.setDisabled(value !== 'custom');

							if (autoCheckDelaySlider)
								this.configureCheckDelay(autoCheckDelaySlider, endpoint);

							await this.notifyEndpointChange(settings);

							await this.plugin.saveSettings();
						});
				});
				setting.addText(text => {
					input = text;
					text
						.setPlaceholder('https://your-custom-url.com')
						.setValue(settings.serverUrl)
						.setDisabled(endpoint !== 'custom')
						.onChange(async value => {
							settings.serverUrl = value.replace(/\/v2\/check\/$/, '').replace(/\/$/, '');

							endpoint = endpointFromUrl(settings.serverUrl);
							if (endpoint !== 'custom') {
								dropdown?.setValue(endpoint);
								input?.setDisabled(true);
							}

							await this.notifyEndpointChange(settings);

							await this.plugin.saveSettings();
						});
				});
			});

		new Setting(containerEl)
			.setName('API username')
			.setDesc('Enter a username/mail for API access')
			.addText(text =>
				text
					.setPlaceholder('peterlustig@example.com')
					.setValue(settings.username || '')
					.onChange(async value => {
						settings.username = value.replace(/\s+/g, '');
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('API key')
			.setDesc(createFragment((frag) => {
				frag.createEl('a', {
					text: 'Click here for information about Premium Access',
					href: 'https://github.com/wrenger/obsidian-languagetool#premium-accounts',
					attr: { target: '_blank' },
				});
			}))
			.addText(text =>
				text.setValue(settings.apikey || '').onChange(async value => {
					settings.apikey = value.replace(/\s+/g, '');
					if (settings.apikey && endpoint !== 'premium') {
						new Notice('You have entered an API Key but you are not using the Premium Endpoint');
					}
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName('Auto check text')
			.setDesc('Check text as you type')
			.addToggle(component => {
				component.setValue(settings.shouldAutoCheck).onChange(async value => {
					settings.shouldAutoCheck = value;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName('Auto check delay (ms)')
			.setDesc('Time to wait for autocheck after the last key press')
			.addSlider(component => {
				autoCheckDelaySlider = component;

				this.configureCheckDelay(component, endpoint);
				component
					.setValue(settings.autoCheckDelay)
					.onChange(async value => {
						settings.autoCheckDelay = value;
						await this.plugin.saveSettings();
					})
					.setDynamicTooltip();
			});

		function synonymsDesc(frag: DocumentFragment): void {
			frag.appendText('Enables the context menu for synonyms fetched from');
			frag.createEl('br');
			if (settings.synonyms != null) {
				let api = SYNONYMS[settings.synonyms];
				if (!api) {
					frag.appendText(' (unknown API)');
					return
				}
				frag.createEl('a', {
					text: api.url,
					href: api.url,
					attr: { target: '_blank' },
				});
			} else {
				frag.appendText('(none)');
			}
		}

		let synonyms = new Setting(containerEl)
			.setName('Find synonyms')
			.setDesc(createFragment(synonymsDesc))
		synonyms
			.addDropdown(component => {
				component.addOption('none', '---');
				for (const lang of Object.keys(SYNONYMS)) {
					component.addOption(lang, lang);
				}
				component.setValue(settings.synonyms ?? 'none')
					.onChange(async value => {
						settings.synonyms = value !== "none" ? value : undefined;
						await this.plugin.saveSettings();
						synonyms.setDesc(createFragment(synonymsDesc));
					});
			});

		new Setting(containerEl)
			.setName('Language settings')
			.setHeading();

		new Setting(containerEl)
			.setName('Mother tongue')
			.setDesc('Set mother tongue if you want to be warned about false friends when writing in other languages. This setting will also be used for automatic language detection.')
			.addDropdown(component => {
				this.languageListeners.push(async languages => {
					// Clear options
					while (component.selectEl.options.length > 0) {
						component.selectEl.remove(0);
					}

					component
						.addOption('none', '---')
						.addOptions(Object.fromEntries(
							// only languages that are not dialects
							languages.filter(v => v.longCode == v.code).map(v => [v.longCode, v.name])
						))
						.setValue(settings.motherTongue ?? 'none')
						.onChange(async value => {
							settings.motherTongue = value !== "none" ? value : undefined;
							await this.plugin.saveSettings();
						});
				})
			});

		let staticLanguage: DropdownComponent | null;
		let langVariants: { [key: string]: { name: string, dropdown: DropdownComponent | null } } = {
			en: { name: "English", dropdown: null },
			de: { name: "German", dropdown: null },
			pt: { name: "Portuguese", dropdown: null },
			ca: { name: "Catalan", dropdown: null },
		};

		new Setting(containerEl)
			.setName('Static language')
			.setDesc(
				'Set a static language that will always be used (LanguageTool tries to auto detect the language, this is usually not necessary)',
			)
			.addDropdown(component => {
				staticLanguage = component;
				this.languageListeners.push(async languages => {
					// Clear options
					while (component.selectEl.options.length > 0) {
						component.selectEl.remove(0);
					}

					component
						.addOption('auto', 'Auto Detect')
						.addOptions(Object.fromEntries(languages.map(v => [v.longCode, v.name])))
						.setValue(settings.staticLanguage ?? 'auto')
						.onChange(async value => {
							settings.staticLanguage = value !== "auto" ? value : undefined;
							if (value !== 'auto') {
								settings.languageVariety = {};

								for (const l of Object.values(langVariants)) {
									l.dropdown?.setValue('default');
								}
							}
							await this.plugin.saveSettings();
						});
				})
			});

		new Setting(containerEl)
			.setName('Language varieties')
			.setHeading()
			.setDesc('Some languages have varieties depending on the country they are spoken in.');

		for (let [id, lang] of Object.entries(langVariants)) {
			new Setting(containerEl).setName(`Interpret ${lang.name} as`).addDropdown(async component => {
				lang.dropdown = component;
				this.configureLanguageVariants(component, id, staticLanguage);
			});
		}

		new Setting(containerEl).setName('Rule categories').setHeading()
			.setDesc(createFragment((frag) => {
				frag.appendText('The picky mode enables a lot of extra categories and rules. Additionally, you can enable or disable specific rules down below.');
				frag.createEl('br');
				frag.createEl('a', {
					text: 'Click here for a list of rules and categories',
					href: 'https://community.languagetool.org/rule/list',
					attr: { target: '_blank' },
				});
			}));

		new Setting(containerEl)
			.setName('Picky mode')
			.setDesc(
				'Provides more style and tonality suggestions, detects long or complex sentences, recognizes colloquialism and redundancies, proactively suggests synonyms for commonly overused words',
			)
			.addToggle(component => {
				component.setValue(settings.pickyMode).onChange(async value => {
					settings.pickyMode = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Enabled categories')
			.setDesc('Comma-separated list of categories')
			.addText(text =>
				text
					.setPlaceholder('CATEGORY_1,CATEGORY_2')
					.setValue(settings.enabledCategories ?? '')
					.onChange(async value => {
						settings.enabledCategories = value.replace(/\s+/g, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Disabled categories')
			.setDesc('Comma-separated list of categories')
			.addText(text =>
				text
					.setPlaceholder('CATEGORY_1,CATEGORY_2')
					.setValue(settings.disabledCategories ?? '')
					.onChange(async value => {
						settings.disabledCategories = value.replace(/\s+/g, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Enabled rules')
			.setDesc('Comma-separated list of rules')
			.addText(text =>
				text
					.setPlaceholder('RULE_1,RULE_2')
					.setValue(settings.enabledRules ?? '')
					.onChange(async value => {
						settings.enabledRules = value.replace(/\s+/g, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Disabled rules')
			.setDesc('Comma-separated list of rules')
			.addText(text =>
				text
					.setPlaceholder('RULE_1,RULE_2')
					.setValue(settings.disabledRules ?? '')
					.onChange(async value => {
						settings.disabledRules = value.replace(/\s+/g, '');
						await this.plugin.saveSettings();
					}),
			);

		await this.notifyEndpointChange(settings);
	}
}
