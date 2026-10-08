import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { RecoveryResult } from '../entities/recovery-result.entity';
import { PriceAlertEntity } from '../entities/price-alert.entity';
import { SmaRecord } from '../entities/sma-record.entity';
import { SmaService } from '../sma/sma.service';

@Injectable()
export class StockService {
  constructor(
    private readonly dataSource: DataSource,

    @InjectRepository(PriceAlertEntity)
    private readonly stockRepository: Repository<PriceAlertEntity>,

    @InjectRepository(RecoveryResult)
    private readonly recoveryResultRepository: Repository<RecoveryResult>,

    @InjectRepository(SmaRecord)
    private readonly smaRecordRepository: Repository<SmaRecord>,
    private readonly smaService: SmaService,
  ) { }

  private formatDateToYMD(dateInput: Date | string): string {
    const d = new Date(dateInput);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    const formatter = new Intl.DateTimeFormat('en-CA', options);
    return formatter.format(d);
  }

  private formatDateTime(dateInput: Date | string): string {
    const d = new Date(dateInput);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    return new Intl.DateTimeFormat('sv-SE', options).format(d).replace(' ', 'T');
  }

  async processRecoveryStocks(periodMonths: number) {
    
    if (periodMonths !== 3 && periodMonths !== 6) {
      throw new BadRequestException('กรุณากรอกช่วงเวลาให้ถูกต้อง (รองรับเฉพาะ 3 หรือ 6 เดือนเท่านั้น)');
    }

    const symbols = ['MSFT', 'NVDA', 'LLY', 'JNJ', 'JPM', 'V', 'AMZN', 'DIS', 'XOM', 'CVX'];

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const initialTargetDateStr = this.formatDateToYMD(yesterday);

    
    const saveOrUpdateResult = async (
      manager: EntityManager,
      symbol: string,
      initialAnalysisDate: string, 
      targetAnalysisDate: string,   
      data: {
        currentPrice: number;
        highestPrice: number;
        lowestPrice: number;
        avgVolume20: number;
        sma50: number;
        volume: number;
        isPassed: boolean;
        reason: string;
      }
    ) => {
      
      let recoveryEntity = await manager.findOne(RecoveryResult, {
        where: {
          symbol: symbol,
          periodMonths: Number(periodMonths)
        },
      });

      let status: 'exists' | 'updated' | 'created';
      const currentTime = new Date();
      const dbAnalysisDateStr = recoveryEntity?.analysisDate ? String(recoveryEntity.analysisDate).split('T')[0] : '';
      const targetDateStrOnly = String(targetAnalysisDate).split('T')[0];

      if (recoveryEntity) {
        const isSame =
          recoveryEntity.isPassed === data.isPassed &&
          Number(recoveryEntity.sma50) === Number(data.sma50) &&
          recoveryEntity.reason === data.reason &&
          Number(recoveryEntity.currentPrice) === Number(data.currentPrice) &&
          dbAnalysisDateStr === targetDateStrOnly;

        if (isSame) {
          recoveryEntity.createdAt = currentTime;
          return { entity: recoveryEntity, status: 'exists' as const };
        }

       
        recoveryEntity.analysisDate = targetAnalysisDate;
        recoveryEntity.currentPrice = data.currentPrice;
        recoveryEntity.highestPrice = data.highestPrice;
        recoveryEntity.lowestPrice = data.lowestPrice;
        recoveryEntity.avgVolume20 = data.avgVolume20;
        recoveryEntity.sma50 = data.sma50;
        recoveryEntity.volume = data.volume;
        recoveryEntity.isPassed = data.isPassed;
        recoveryEntity.reason = data.reason;
        recoveryEntity.createdAt = currentTime;

        status = 'updated';
      } else {
        recoveryEntity = manager.create(RecoveryResult, {
          symbol,
          analysisDate: targetAnalysisDate,
          periodMonths: Number(periodMonths),
          createdAt: currentTime,
          ...data,
        });
        status = 'created';
      }

      const savedEntity = await manager.save(recoveryEntity);
      return { entity: savedEntity, status };
    };

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    
    try {
      const allAnalyzedResults: { entity: RecoveryResult; effectiveDate: string }[] = [];
      let hasUpdated = false;
      let hasExists = false;

      const targetDate = new Date();
      targetDate.setMonth(targetDate.getMonth() - periodMonths);
      const targetDateStr = this.formatDateToYMD(targetDate);

      for (const symbol of symbols) {
        const rawPrices = await queryRunner.manager
          .createQueryBuilder(PriceAlertEntity, 's')
          .where('s.symbol = :symbol', { symbol })
          .andWhere('s.price_date >= :targetDateStr', { targetDateStr })
          .orderBy('s.price_date', 'ASC')
          .getMany();

        if (!rawPrices || rawPrices.length === 0) {
          const result = await saveOrUpdateResult(
            queryRunner.manager, 
            symbol, 
            initialTargetDateStr, 
            initialTargetDateStr, 
            {
              currentPrice: 0,
              highestPrice: 0,
              lowestPrice: 0,
              avgVolume20: 0,
              sma50: 0,
              volume: 0,
              isPassed: false,
              reason: 'ไม่ผ่านเกณฑ์: ไม่พบข้อมูลราคาหุ้นในฐานข้อมูลช่วงเวลานี้',
            }
          );

          allAnalyzedResults.push({ entity: result.entity, effectiveDate: initialTargetDateStr });
          if (result.status === 'updated') hasUpdated = true;
          if (result.status === 'exists') hasExists = true;
          continue;
        }

        const priceMap = new Map<string, PriceAlertEntity>();
        rawPrices.forEach(p => {
          if (p.price_date) {
            priceMap.set(this.formatDateToYMD(p.price_date), p);
          }
        });

        
        const initialRecord = priceMap.get(initialTargetDateStr);

        if (!initialRecord) {
          const result = await saveOrUpdateResult(
            queryRunner.manager, 
            symbol, 
            initialTargetDateStr, 
            initialTargetDateStr, 
            {
              currentPrice: 0,
              highestPrice: 0,
              lowestPrice: 0,
              avgVolume20: 0,
              sma50: 0,
              volume: 0,
              isPassed: false,
              reason: 'ไม่ผ่านเกณฑ์: ไม่พบข้อมูลราคาหุ้นในช่วงเวลานี้',
            }
          );

          allAnalyzedResults.push({ entity: result.entity, effectiveDate: initialTargetDateStr });
          if (result.status === 'updated') hasUpdated = true;
          if (result.status === 'exists') hasExists = true;
          continue;
        }

        let targetAnalysisDateStr = initialTargetDateStr;
        let targetRecord: PriceAlertEntity | undefined = initialRecord;

        let checkDate = new Date(initialTargetDateStr);
        let loopLimit = 10;

       
        while (loopLimit > 0 && (!targetRecord || targetRecord.eod_price === null || targetRecord.eod_price === undefined)) {
          checkDate.setDate(checkDate.getDate() - 1);
          targetAnalysisDateStr = this.formatDateToYMD(checkDate);
          targetRecord = priceMap.get(targetAnalysisDateStr);
          loopLimit--;
        }

        if (!targetRecord || targetRecord.eod_price === null || targetRecord.eod_price === undefined) {
          const result = await saveOrUpdateResult(
            queryRunner.manager, 
            symbol, 
            initialTargetDateStr, 
            initialTargetDateStr, 
            {
              currentPrice: 0,
              highestPrice: 0,
              lowestPrice: 0,
              avgVolume20: 0,
              sma50: 0,
              volume: 0,
              isPassed: false,
              reason: 'ไม่ผ่านเกณฑ์: ไม่มีข้อมูลราคาซื้อขายล่าสุดในระบบ',
            }
          );

          allAnalyzedResults.push({ entity: result.entity, effectiveDate: initialTargetDateStr });
          if (result.status === 'updated') hasUpdated = true;
          if (result.status === 'exists') hasExists = true;
          continue;
        }

        const validPrices = rawPrices
          .filter(p => p.price_date && this.formatDateToYMD(p.price_date) <= targetAnalysisDateStr && p.eod_price !== null && p.eod_price !== undefined)
          .map(p => ({
            date: this.formatDateToYMD(p.price_date),
            close: Number(p.eod_price),
            volume: Number(p.volume || 0),
          }));

        if (validPrices.length < 50) {
          const result = await saveOrUpdateResult(
            queryRunner.manager, 
            symbol, 
            initialTargetDateStr, 
            targetAnalysisDateStr, 
            {
              currentPrice: 0,
              highestPrice: 0,
              lowestPrice: 0,
              avgVolume20: 0,
              sma50: 0,
              volume: 0,
              isPassed: false,
              reason: `ไม่ผ่านเกณฑ์: ข้อมูลราคาในฐานข้อมูลไม่เพียงพอสำหรับการวิเคราะห์ (มีเพียง ${validPrices.length} วัน ต้องการอย่างน้อย 50 วัน)`,
            }
          );

          allAnalyzedResults.push({ entity: result.entity, effectiveDate: targetAnalysisDateStr });
          if (result.status === 'updated') hasUpdated = true;
          if (result.status === 'exists') hasExists = true;
          continue;
        }

        const latestData = validPrices[validPrices.length - 1];
        const latestPriceDate = latestData.date;
        const currentPrice = latestData.close;
        const currentVolume = latestData.volume;

        const closes = validPrices.map(p => p.close);
        const highestPrice = Math.max(...closes);
        const lowestPrice = Math.min(...closes);

        const last20Volumes = validPrices.slice(-20).map(p => p.volume);
        const avgVolume20 = last20Volumes.reduce((a, b) => a + b, 0) / last20Volumes.length;

        const period = 50;
        let smaRecord = await queryRunner.manager
          .createQueryBuilder(SmaRecord, 'sma')
          .where('sma.symbol = :symbol', { symbol })
          .andWhere('sma.period = :period', { period })
          .orderBy('sma.calculatedAt', 'DESC')
          .getOne();

        if (!smaRecord || !smaRecord.latestDate || this.formatDateToYMD(smaRecord.latestDate) !== latestPriceDate) {
          try {
            await this.smaService.processSmaRequest({ symbol, period });

            smaRecord = await queryRunner.manager
              .createQueryBuilder(SmaRecord, 'sma')
              .where('sma.symbol = :symbol', { symbol })
              .andWhere('sma.period = :period', { period })
              .orderBy('sma.calculatedAt', 'DESC')
              .getOne();
          } catch (error) {
            console.error(`ไม่สามารถคำนวณ SMA สำหรับ ${symbol} ได้:`, error);
          }
        }

        const sma50 = smaRecord ? Number(smaRecord.smaValue) : 0;

        if (sma50 === 0 || !smaRecord || !smaRecord.latestDate || this.formatDateToYMD(smaRecord.latestDate) !== latestPriceDate) {
          const result = await saveOrUpdateResult(
            queryRunner.manager, 
            symbol, 
            initialTargetDateStr, 
            targetAnalysisDateStr, 
            {
              currentPrice,
              highestPrice,
              lowestPrice,
              avgVolume20,
              sma50: 0,
              volume: currentVolume,
              isPassed: false,
              reason: `ไม่ผ่านเกณฑ์: ไม่พบข้อมูลเส้นค่าเฉลี่ย SMA50 ที่มี latestDate ตรงกับวันที่ ${latestPriceDate} ในระบบ`,
            }
          );

          allAnalyzedResults.push({ entity: result.entity, effectiveDate: targetAnalysisDateStr });
          if (result.status === 'updated') hasUpdated = true;
          if (result.status === 'exists') hasExists = true;
          continue;
        }

        const dropFromHigh = (highestPrice - currentPrice) / highestPrice >= 0.20;
        const recoveryFromLow = (currentPrice - lowestPrice) / lowestPrice >= 0.10;
        const volumeCondition = currentVolume > avgVolume20;
        const smaCondition = currentPrice > sma50;

        const isPassed = dropFromHigh && recoveryFromLow && volumeCondition && smaCondition;

        const isFallbackDate = targetAnalysisDateStr !== initialTargetDateStr;
        let reason = 'ผ่านเกณฑ์หุ้นฟื้นทั้งหมด';
       if (!isPassed) {
          const failedCriteria: string[] = [];
          if (!dropFromHigh) failedCriteria.push('ราคาตกจากจุดสูงสุดยังไม่ถึง 20%');
          if (!recoveryFromLow) failedCriteria.push('การฟื้นตัวจากจุดต่ำสุดยังไม่ถึง 10%');
          if (!volumeCondition) failedCriteria.push('ปริมาณการซื้อขายรายวันน้อยกว่าค่าเฉลี่ยปริมาณการซื้อขายย้อนหลัง 20 วัน');
          if (!smaCondition) failedCriteria.push('ราคาปิดปัจจุบันต่ำกว่าเส้น SMA50'); 

          reason = `ไม่ผ่านเกณฑ์: ${failedCriteria.join(', ')}`;
        }
        if (isFallbackDate) {
          reason = `วันที่ ${initialTargetDateStr} เป็นวันหยุด ระบบจึงใช้ข้อมูลการวิเคราะห์ของวันที่ ${targetAnalysisDateStr} แทน ${reason}`;
        }

        const result = await saveOrUpdateResult(
          queryRunner.manager, 
          symbol, 
          initialTargetDateStr, 
          targetAnalysisDateStr, 
          {
            currentPrice,
            highestPrice,
            lowestPrice,
            avgVolume20,
            sma50,
            volume: currentVolume,
            isPassed,
            reason,
          }
        );

        allAnalyzedResults.push({ entity: result.entity, effectiveDate: targetAnalysisDateStr });
        if (result.status === 'updated') hasUpdated = true;
        if (result.status === 'exists') hasExists = true;
      }

      await queryRunner.commitTransaction();


      const sortedResults = await this.recoveryResultRepository.find({
        where: { periodMonths: Number(periodMonths) },
        order: {
          analysisDate: 'DESC',
          symbol: 'ASC',
        },
      });

      let message = 'วิเคราะห์หุ้นฟื้นตัวสำเร็จเรียบร้อยแล้ว';
      if (hasUpdated) {
        message = 'อัปเดตข้อมูลในตารางแล้ว';
      } else if (hasExists) {
        message = 'มีข้อมูลในตารางแล้ว';
      }

      return {
        message,
        totalAnalyzed: sortedResults.length, 
        totalPassed: sortedResults.filter(item => item.isPassed).length, 
        statusCode: 200,
        data: sortedResults.map((entity) => { 
          const rest: Partial<RecoveryResult> = { ...entity };
          delete rest.id;

          return {
            ...rest,
            analysisDate: rest.analysisDate ? String(rest.analysisDate).split('T')[0] : '',
            createdAt: this.formatDateTime(entity.createdAt),
          };
        }),
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      console.error('ERROR DETAIL', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในระบบ ไม่สามารถดำเนินงานได้',
      );
    } finally {
      await queryRunner.release();
    }
  }
}